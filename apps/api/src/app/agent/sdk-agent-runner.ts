import { Inject, Injectable, Logger } from '@nestjs/common';
import type * as Sdk from '@anthropic-ai/claude-agent-sdk';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import type {
  AgentRun,
  AgentRunner,
  AgentStartOptions,
  AgentUserMessage,
} from './agent-runner';
import { AsyncQueue } from './async-queue';

type SdkModule = typeof Sdk;

let sdkModule: Promise<SdkModule> | undefined;

/**
 * Loads the Agent SDK. It is an ES module while the API bundle is CommonJS,
 * so it is loaded with a native dynamic import that TypeScript and webpack
 * leave alone.
 */
export function loadAgentSdk(): Promise<SdkModule> {
  sdkModule ??= (
    new Function('s', 'return import(s)') as (s: string) => Promise<SdkModule>
  )('@anthropic-ai/claude-agent-sdk');
  return sdkModule;
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
): Sdk.Options {
  return {
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
      options: buildQueryOptions(options, this.config, (data) => {
        this.logger.debug(data.trimEnd());
        for (const line of data.split('\n')) {
          if (line.trim()) {
            stderr.push(line.trim());
          }
        }
        stderr.splice(0, Math.max(0, stderr.length - STDERR_LINES));
      }),
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
