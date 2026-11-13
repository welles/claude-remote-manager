import { Inject, Injectable, Logger } from '@nestjs/common';
import type * as Sdk from '@anthropic-ai/claude-agent-sdk';
import type * as Zod from 'zod';
import { APP_MCP_SERVER } from '../sessions/approval-grants';
import {
  CLAUDE_CODE_SECRETS,
  childEnvironment,
} from '../common/child-environment';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import type {
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
 * The app's tools as an in-process MCP server (`createSdkMcpServer`), with
 * the permission policy `always_ask` for tools that need the user's
 * approval on every call.
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
        async (input) => {
          try {
            const result = await definition.handler(
              input as Record<string, unknown>,
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
      ),
    ),
  });
  return {
    [APP_MCP_SERVER]: {
      ...server,
      tools: tools
        .filter((definition) => definition.alwaysAsk)
        .map((definition) => ({
          name: definition.name,
          permission_policy: 'always_ask' as const,
        })),
    },
  };
}

/**
 * Settings that every session gets: the user's settings and CLAUDE.md from
 * CLAUDE_CONFIG_DIR, the project's settings and CLAUDE.md files from the
 * working directory (and its parents), and local settings. Managed policy
 * settings, such as /etc/claude-code/CLAUDE.md in the image, are always
 * loaded by Claude Code regardless of this list.
 */
export const SETTING_SOURCES: Sdk.SettingSource[] = [
  'user',
  'project',
  'local',
];

/** Lines of Claude Code's stderr kept for error messages. */
const STDERR_LINES = 5;

/** Builds the SDK options for a session. Exported for tests. */
export function buildQueryOptions(
  options: AgentStartOptions,
  config: Pick<AppConfig, 'claudeExecutable'>,
  stderr: (data: string) => void,
  baseEnv: NodeJS.ProcessEnv = process.env,
  mcpServers?: Record<string, Sdk.McpServerConfig>,
): Sdk.Options {
  return {
    ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
    // Replaces the inherited environment: no app secrets except Claude
    // Code's own login.
    env: childEnvironment(options.env, {
      keep: CLAUDE_CODE_SECRETS,
      base: baseEnv,
    }),
    cwd: options.cwd,
    additionalDirectories: options.additionalDirectories,
    ...(options.model ? { model: options.model } : {}),
    permissionMode: options.permissionMode,
    canUseTool: options.canUseTool,
    ...(options.resume
      ? { resume: options.resume }
      : options.sessionId
        ? { sessionId: options.sessionId }
        : {}),
    // Without this the SDK uses a minimal system prompt instead of Claude
    // Code's own (see the Agent SDK docs on modifying system prompts).
    systemPrompt: { type: 'preset', preset: 'claude_code' },
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

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async start(
    options: AgentStartOptions,
    firstMessage: AgentUserMessage,
  ): Promise<AgentRun> {
    const sdk = await loadAgentSdk();
    const input = new AsyncQueue<Sdk.SDKUserMessage>();
    const toSdk = (message: AgentUserMessage): Sdk.SDKUserMessage => ({
      type: 'user',
      message: { role: 'user', content: message.text },
      parent_tool_use_id: null,
      uuid: message.id as Sdk.SDKUserMessage['uuid'],
    });
    input.push(toSdk(firstMessage));
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
      ),
    });

    return {
      messages: query,
      send: (message) => input.push(toSdk(message)),
      interrupt: async () => {
        await query.interrupt();
      },
      contextUsage: () => query.getContextUsage({ detail: 'summary' }),
      planUsage: () =>
        query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
          skipBehaviors: true,
        }),
      close: () => {
        input.close();
        query.close();
      },
      stderrTail: () => [...stderr],
    };
  }
}
