import type {
  CanUseTool,
  SDKControlGetContextUsageResponse,
  SDKControlGetUsageResponse,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { SessionPermissionMode } from '@claude-remote-manager/shared-types';

/** What a Claude Code process is started with. */
export interface AgentStartOptions {
  cwd: string;
  additionalDirectories: string[];
  /** Model name or alias; `null` uses Claude Code's default. */
  model: string | null;
  permissionMode: SessionPermissionMode;
  /** Claude Code session to resume, or `null` for a new one. */
  resume: string | null;
  /** Session ID for a new Claude Code session (ignored when resuming). */
  sessionId: string | null;
  /** Decides tool uses that need the user's approval. */
  canUseTool: CanUseTool;
}

/** A user message sent into a running Claude Code process. */
export interface AgentUserMessage {
  /** Client-side UUID; Claude Code echoes it on the answer. */
  id: string;
  text: string;
}

/**
 * One running Claude Code process in streaming-input mode: it keeps
 * running and accepts further user messages until it is closed.
 */
export interface AgentRun {
  /** All messages of the process; ends when the process ends. */
  readonly messages: AsyncIterable<SDKMessage>;
  /** Sends a user message; it starts a turn or queues behind the running one. */
  send(message: AgentUserMessage): void;
  /** Stops the running turn. */
  interrupt(): Promise<void>;
  /** Context window usage, computed without extra API requests. */
  contextUsage(): Promise<SDKControlGetContextUsageResponse>;
  /** Plan rate limits (experimental SDK API, may change). */
  planUsage(): Promise<SDKControlGetUsageResponse>;
  /** Ends the input and terminates the process. */
  close(): void;
}

/**
 * Starts Claude Code processes. An abstract class so that it can serve as
 * the Nest injection token and be replaced by a fake in tests.
 */
export abstract class AgentRunner {
  abstract start(
    options: AgentStartOptions,
    firstMessage: AgentUserMessage,
  ): Promise<AgentRun>;
}
