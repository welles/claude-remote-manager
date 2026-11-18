import type {
  CanUseTool,
  ModelInfo,
  SDKControlGetContextUsageResponse,
  SDKControlGetUsageResponse,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { SessionPermissionMode } from '@claude-remote-manager/shared-types';
import type * as Zod from 'zod';

/** What the app's tool knows about the call. */
export interface AgentToolContext {
  /** The tool use (`claudecode/toolUseId` of the MCP request), if known. */
  toolUseId: string | null;
}

/** Result of one of the app's own tools. */
export interface AgentToolResult {
  text: string;
  isError?: boolean;
}

/**
 * A tool the app gives Claude (served in-process as MCP server `crm`; the
 * name Claude sees is `mcp__crm__<name>`).
 */
export interface AgentTool {
  name: string;
  description: string;
  /** Input schema as Zod raw shape, built with the Zod the SDK uses. */
  inputSchema: (z: typeof Zod) => Record<string, Zod.ZodType>;
  /**
   * Ask `canUseTool` before every call, even where a permission rule
   * allows the tool (MCP tool permission policy `always_ask`).
   */
  alwaysAsk: boolean;
  /** The tool only reads (MCP annotation `readOnlyHint`). */
  readOnly?: boolean;
  handler: (
    input: Record<string, unknown>,
    context: AgentToolContext,
  ) => Promise<AgentToolResult>;
}

/** A tool call as Claude Code announces it before deciding about it. */
export interface AgentToolCall {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string | null;
  /** Set when a subagent makes the call. */
  agentId: string | null;
}

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
  /**
   * Tool calls that must reach `canUseTool` whatever the permission mode
   * (also where `auto` mode's classifier would decide them): returns the
   * reason shown in the approval dialog, `null` for other calls. Claude
   * Code learns it through a PreToolUse hook answering `ask`.
   */
  alwaysAsk?: (call: AgentToolCall) => string | null;
  /**
   * Permission rules allowed for this process (in memory, like rules the
   * user allowed for the session; never written to settings files).
   */
  allowedTools?: string[];
  /** Variables added to the process environment (without app secrets). */
  env?: Record<string, string>;
  /** The app's own tools for this session. */
  tools?: AgentTool[];
  /**
   * Settings on top of the user's, project's and local settings (Claude
   * Code's flag settings), e.g. the auto-memory directory.
   */
  settings?: Record<string, unknown>;
}

/** An image of a user message (base64). */
export interface AgentUserImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
}

/** A user message sent into a running Claude Code process. */
export interface AgentUserMessage {
  /** Client-side UUID; Claude Code echoes it on the answer. */
  id: string;
  /** May be empty when there are images. */
  text: string;
  /** Images, sent as image content before the text. */
  images?: AgentUserImage[];
  /**
   * Untrusted context for this message (GitHub content, see
   * `untrusted-context.ts`), sent to Claude Code as a message of its own
   * right before this one, delivered as written: no `@path` expansion and
   * no slash command, without a turn of its own. `id` is its UUID in the
   * transcript.
   */
  context?: { id: string; text: string };
  /**
   * A note of the app for Claude (e.g. that the user added a repository to
   * the session), sent like `context` as a message of its own before it,
   * delivered as written and without a turn of its own. Trusted text the
   * app composed; Claude Code marks it as not from the user.
   */
  note?: { id: string; text: string };
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
  /** Switches the permission mode of the running process. */
  setPermissionMode(mode: SessionPermissionMode): Promise<void>;
  /** Switches the model for the next requests; `null`: the default. */
  setModel(model: string | null): Promise<void>;
  /**
   * Makes further directories working directories of the running process
   * (also in the middle of a turn); Claude Code tells Claude about them
   * with its next request. Rejects when this Claude Code cannot do it.
   */
  addDirectories(directories: string[]): Promise<void>;
  /** Ends the input and terminates the process. */
  close(): void;
  /** The last lines Claude Code wrote to stderr, for error messages. */
  stderrTail(): string[];
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

  /**
   * Starts a short-lived Claude Code process without a prompt (no model
   * request, no transcript) to ask it about the account, and closes it.
   */
  abstract probe<T>(task: (probe: AgentProbe) => Promise<T>): Promise<T>;
}

/** What a probe process can be asked. */
export interface AgentProbe {
  /** Models Claude Code offers for the logged-in account. */
  supportedModels(): Promise<ModelInfo[]>;
  /** Plan rate limits (experimental SDK API, may change). */
  planUsage(): Promise<SDKControlGetUsageResponse>;
}
