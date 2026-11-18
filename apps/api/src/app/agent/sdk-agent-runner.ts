import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type * as Sdk from '@anthropic-ai/claude-agent-sdk';
import type * as Zod from 'zod';
import { APP_MCP_SERVER } from '../sessions/app-tools';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { CLAUDE_CODE_SECRETS } from '../common/child-environment';
import {
  PROCESS_LAUNCHER,
  SINGLE_USER,
  type ProcessLauncher,
} from '../common/process-isolation';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import type {
  AgentProbe,
  AgentRun,
  AgentRunner,
  AgentStartOptions,
  AgentTool,
  AgentUserMessage,
} from './agent-runner';
import { AsyncQueue } from './async-queue';

type SdkModule = typeof Sdk;

let sdkModule: Promise<SdkModule> | undefined;
let zodModule: Promise<typeof Zod> | undefined;

const nativeImport = new Function('s', 'return import(s)') as <T>(
  specifier: string,
) => Promise<T>;

/**
 * Loads the Agent SDK. It is an ES module while the API bundle is CommonJS,
 * so it is loaded with a native dynamic import that TypeScript and webpack
 * leave alone.
 */
export function loadAgentSdk(): Promise<SdkModule> {
  sdkModule ??= nativeImport<SdkModule>('@anthropic-ai/claude-agent-sdk');
  return sdkModule;
}

/** Zod as ES module, the same instance the Agent SDK imports. */
function loadZod(): Promise<typeof Zod> {
  zodModule ??= nativeImport<typeof Zod>('zod');
  return zodModule;
}

/**
 * The tool use ID Claude Code sends with a call of an MCP tool, in the
 * request's `_meta` (`claudecode/toolUseId`); `null` without.
 */
export function toolUseIdOf(extra: unknown): string | null {
  const meta =
    typeof extra === 'object' && extra !== null
      ? (extra as { _meta?: unknown })._meta
      : undefined;
  const id =
    typeof meta === 'object' && meta !== null
      ? (meta as Record<string, unknown>)['claudecode/toolUseId']
      : undefined;
  return typeof id === 'string' && id ? id : null;
}

/**
 * The app's tools as an in-process MCP server (`createSdkMcpServer`). They
 * ask like any tool, as the session's permission mode and rules say.
 */
export async function appMcpServers(
  tools: AgentTool[] | undefined,
): Promise<Record<string, Sdk.McpServerConfig>> {
  if (!tools || tools.length === 0) {
    return {};
  }
  const sdk = await loadAgentSdk();
  const z = await loadZod();
  const server = sdk.createSdkMcpServer({
    name: APP_MCP_SERVER,
    version: '1.0.0',
    alwaysLoad: true,
    tools: tools.map((definition) =>
      sdk.tool(
        definition.name,
        definition.description,
        definition.inputSchema(z),
        async (input, extra) => {
          try {
            const result = await definition.handler(
              input as Record<string, unknown>,
              { toolUseId: toolUseIdOf(extra) },
            );
            return {
              content: [{ type: 'text', text: result.text }],
              ...(result.isError ? { isError: true } : {}),
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text: error instanceof Error ? error.message : String(error),
                },
              ],
              isError: true,
            };
          }
        },
        definition.readOnly
          ? { annotations: { readOnlyHint: true } }
          : undefined,
      ),
    ),
  });
  return { [APP_MCP_SERVER]: server };
}

/**
 * Settings that every session gets, as in a terminal: the user's settings,
 * CLAUDE.md, skills, plugins and MCP servers from the user's configuration
 * directory (`~/.claude`, or `CLAUDE_CONFIG_DIR` where set, as in the
 * image), the project's settings and CLAUDE.md files from the working
 * directory (and its parents), and local settings. Managed policy
 * settings, such as /etc/claude-code/CLAUDE.md in the image, are always
 * loaded by Claude Code regardless of this list.
 */
export const SETTING_SOURCES: Sdk.SettingSource[] = [
  'user',
  'project',
  'local',
];

/**
 * Sessions get the MCP servers a terminal session would get (the user's,
 * a project's `.mcp.json` as approved there, plugins, the Claude account's
 * claude.ai connectors) plus the app's own in-process server `crm`.
 */
export const STRICT_MCP_CONFIG = false;

/**
 * Auxiliary queries of the app (the model list and plan usage, see
 * {@link SdkAgentRunner.probe}) make no model request and use no tools:
 * they start no MCP server and fetch no connectors.
 */
export const PROBE_SETTINGS = {
  strictMcpConfig: true,
  settings: { disableClaudeAiConnectors: true },
} as const;

/** Lines of Claude Code's stderr kept for error messages. */
const STDERR_LINES = 5;

/**
 * Starts Claude Code as the session user (separate-users mode): the SDK's
 * command goes through `setpriv`, with the environment the SDK built from
 * the allowlist. stderr is forwarded like the SDK's own spawn does.
 */
export function spawnAsSession(
  launcher: ProcessLauncher,
  options: Sdk.SpawnOptions,
  stderr: (data: string) => void,
): Sdk.SpawnedProcess {
  const command = launcher.command('session', options.command, options.args);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.env)) {
    if (value !== undefined) {
      env[name] = value;
    }
  }
  const child = spawn(command.command, command.args, {
    cwd: options.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: options.signal,
  });
  child.stderr?.on('data', (chunk: Buffer) => stderr(chunk.toString('utf8')));
  // With stdio "pipe" the streams exist.
  return child as ChildProcess & Sdk.SpawnedProcess;
}

/**
 * Content of a user message: the text, or with images Messages API image
 * blocks (base64) followed by the text block. Claude Code expands `@path`
 * file mentions in the text either way.
 */
export function userContent(
  message: AgentUserMessage,
): Sdk.SDKUserMessage['message']['content'] {
  if (!message.images || message.images.length === 0) {
    return message.text;
  }
  return [
    ...message.images.map((image) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: image.mediaType,
        data: image.data,
      },
    })),
    ...(message.text.trim()
      ? [{ type: 'text' as const, text: message.text }]
      : []),
  ];
}

/**
 * The SDK messages for a user message: the message itself, preceded by the
 * app's note and its untrusted context if any. Each goes as its own
 * message with
 * - `client_composed: true`: Claude Code delivers the text as written, with
 *   no `@path` file expansion and no slash-command dispatch;
 * - `shouldQuery: false`: it starts no turn; Claude Code merges it into the
 *   next message, the user's, whose text keeps `@` expansion and the
 *   context Claude Code attaches at the start of a turn (which
 *   `client_composed` would skip for the turn it starts);
 * - `isSynthetic: true`: Claude Code prefixes it with "[MESSAGE FROM
 *   NON-USER SOURCE - NOT USER INPUT]" and leaves it out of the
 *   conversation `getSessionMessages` returns.
 * Checked with the bundled Claude Code (see the README).
 */
export function sdkUserMessages(
  message: AgentUserMessage,
): Sdk.SDKUserMessage[] {
  const user: Sdk.SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content: userContent(message) },
    parent_tool_use_id: null,
    uuid: message.id as Sdk.SDKUserMessage['uuid'],
  };
  const before = [message.note, message.context].filter(
    (entry): entry is { id: string; text: string } => !!entry,
  );
  return [
    ...before.map(
      (entry): Sdk.SDKUserMessage => ({
        type: 'user',
        message: { role: 'user', content: entry.text },
        parent_tool_use_id: null,
        uuid: entry.id as Sdk.SDKUserMessage['uuid'],
        client_composed: true,
        shouldQuery: false,
        isSynthetic: true,
      }),
    ),
    user,
  ];
}

/**
 * Messages that Claude Code answers with a result of zero turns before the
 * message itself: its note and its untrusted context.
 */
export function zeroTurnMessages(message: AgentUserMessage): number {
  return (message.note ? 1 : 0) + (message.context ? 1 : 0);
}

/**
 * How long Claude Code waits for the gate (seconds): it may wait for the
 * user's answer, as long as an approval request may wait.
 */
const GATE_TIMEOUT_SECONDS = 365 * 24 * 60 * 60;

/**
 * The PreToolUse hook through which `gate` decides tool calls before
 * Claude Code's own permission check: `allow` and `deny` are final (allow
 * rules and modes do not matter), `null` leaves the call to Claude Code.
 * A failure of the hook blocks the call (`onFailure: 'block'`).
 */
export function gateHooks(
  gate: NonNullable<AgentStartOptions['gate']>,
): NonNullable<Sdk.Options['hooks']> {
  return {
    PreToolUse: [
      {
        onFailure: 'block',
        timeout: GATE_TIMEOUT_SECONDS,
        hooks: [
          async (input, _toolUseId, { signal }) => {
            if (input.hook_event_name !== 'PreToolUse') {
              return {};
            }
            const toolInput =
              typeof input.tool_input === 'object' && input.tool_input !== null
                ? (input.tool_input as Record<string, unknown>)
                : {};
            const decision = await gate(
              {
                toolName: input.tool_name,
                input: toolInput,
                toolUseId: input.tool_use_id,
                agentId: input.agent_id ?? null,
                mcpServer: input.mcp_server ?? null,
              },
              signal,
            );
            if (decision === null) {
              return {};
            }
            return decision.behavior === 'allow'
              ? {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'allow',
                    ...(decision.updatedInput
                      ? { updatedInput: decision.updatedInput }
                      : {}),
                  },
                }
              : {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: decision.message,
                  },
                };
          },
        ],
      },
    ],
  };
}

/** Builds the SDK options for a session. Exported for tests. */
export function buildQueryOptions(
  options: AgentStartOptions,
  config: Pick<AppConfig, 'claudeExecutable'>,
  stderr: (data: string) => void,
  baseEnv: NodeJS.ProcessEnv = process.env,
  mcpServers?: Record<string, Sdk.McpServerConfig>,
  launcher: ProcessLauncher = SINGLE_USER,
): Sdk.Options {
  return {
    ...(launcher.separated
      ? {
          spawnClaudeCodeProcess: (spawnOptions: Sdk.SpawnOptions) =>
            spawnAsSession(launcher, spawnOptions, stderr),
        }
      : {}),
    ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    strictMcpConfig: STRICT_MCP_CONFIG,
    ...(options.settings ? { settings: options.settings } : {}),
    // Replaces the inherited environment: the API's environment (the
    // user's, where sessions run as the API's user) without the app's own
    // secrets, except Claude Code's login (with separate users: only
    // allowlisted variables).
    env: launcher.environment('session', options.env, {
      keep: CLAUDE_CODE_SECRETS,
      base: baseEnv,
    }),
    cwd: options.cwd,
    additionalDirectories: options.additionalDirectories,
    ...(options.allowedTools && options.allowedTools.length > 0
      ? { allowedTools: options.allowedTools }
      : {}),
    ...(options.model ? { model: options.model } : {}),
    permissionMode: options.permissionMode,
    // Makes `bypassPermissions` available, also for a switch while the
    // process runs (`setPermissionMode`); the mode itself is the session's
    // choice. As `--allow-dangerously-skip-permissions`.
    allowDangerouslySkipPermissions: true,
    canUseTool: options.canUseTool,
    ...(options.gate ? { hooks: gateHooks(options.gate) } : {}),
    ...(options.resume
      ? { resume: options.resume }
      : options.sessionId
        ? { sessionId: options.sessionId }
        : {}),
    // Without this the SDK uses a minimal system prompt instead of Claude
    // Code's own (see the Agent SDK docs on modifying system prompts).
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      ...(options.instructions ? { append: options.instructions } : {}),
    },
    settingSources: SETTING_SOURCES,
    includePartialMessages: true,
    ...(config.claudeExecutable
      ? { pathToClaudeCodeExecutable: config.claudeExecutable }
      : {}),
    stderr,
  };
}

/** Runs sessions with the Claude Agent SDK. */
@Injectable()
export class SdkAgentRunner implements AgentRunner {
  private readonly logger = new Logger(SdkAgentRunner.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional()
    @Inject(PROCESS_LAUNCHER)
    private readonly launcher: ProcessLauncher = SINGLE_USER,
  ) {}

  async start(
    options: AgentStartOptions,
    firstMessage: AgentUserMessage,
  ): Promise<AgentRun> {
    const sdk = await loadAgentSdk();
    const input = new AsyncQueue<Sdk.SDKUserMessage>();
    const push = (message: AgentUserMessage) => {
      for (const sdkMessage of sdkUserMessages(message)) {
        input.push(sdkMessage);
      }
    };
    push(firstMessage);
    const stderr: string[] = [];
    const query = sdk.query({
      prompt: input,
      options: buildQueryOptions(
        options,
        this.config,
        (data) => {
          this.logger.debug(data.trimEnd());
          for (const line of data.split('\n')) {
            if (line.trim()) {
              stderr.push(line.trim());
            }
          }
          stderr.splice(0, Math.max(0, stderr.length - STDERR_LINES));
        },
        process.env,
        await appMcpServers(options.tools),
        this.launcher,
      ),
    });

    // Directories added while the process runs. Claude Code takes them as
    // `permissions.additionalDirectories` of the flag settings, which
    // replaces the whole `permissions` object set at launch: it is sent
    // again with them (checked with the bundled Claude Code, see README).
    const added = new Set<string>();
    const launchPermissions =
      typeof options.settings?.['permissions'] === 'object' &&
      options.settings['permissions'] !== null
        ? (options.settings['permissions'] as Record<string, unknown>)
        : {};
    return {
      messages: query,
      send: push,
      addDirectories: async (directories) => {
        const next = new Set([...added, ...directories]);
        await query.applyFlagSettings({
          permissions: {
            ...launchPermissions,
            additionalDirectories: [...next],
          },
        });
        for (const directory of directories) {
          added.add(directory);
        }
      },
      interrupt: async () => {
        await query.interrupt();
      },
      contextUsage: () => query.getContextUsage({ detail: 'summary' }),
      planUsage: () =>
        query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
          skipBehaviors: true,
        }),
      setPermissionMode: (mode) => query.setPermissionMode(mode),
      setModel: (model) => query.setModel(model ?? undefined),
      close: () => {
        input.close();
        query.close();
      },
      stderrTail: () => [...stderr],
    };
  }

  async probe<T>(task: (probe: AgentProbe) => Promise<T>): Promise<T> {
    const sdk = await loadAgentSdk();
    // Streaming input that never sends a message: Claude Code initializes
    // and answers control requests, but makes no model request.
    const input = new AsyncQueue<Sdk.SDKUserMessage>();
    const query = sdk.query({
      prompt: input,
      options: {
        ...(this.launcher.separated
          ? {
              spawnClaudeCodeProcess: (spawnOptions: Sdk.SpawnOptions) =>
                spawnAsSession(this.launcher, spawnOptions, () => undefined),
            }
          : {}),
        env: this.launcher.environment(
          'session',
          {},
          { keep: CLAUDE_CODE_SECRETS, base: process.env },
        ),
        // Readable for the session user; nothing is written there.
        cwd: tmpdir(),
        settingSources: ['user'],
        ...PROBE_SETTINGS,
        permissionMode: 'default',
        ...(this.config.claudeExecutable
          ? { pathToClaudeCodeExecutable: this.config.claudeExecutable }
          : {}),
        stderr: (data) => this.logger.debug(data.trimEnd()),
      },
    });
    try {
      return await task({
        supportedModels: () => query.supportedModels(),
        planUsage: () =>
          query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
            skipBehaviors: true,
          }),
      });
    } finally {
      input.close();
      query.close();
    }
  }
}
