import type {
  CanUseTool,
  ModelInfo,
  ModelUsage,
  SDKControlGetContextUsageResponse,
  SDKControlGetUsageResponse,
  SDKMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  ReviewEffort,
  SessionPermissionMode,
} from '@claude-remote-manager/shared-types';
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
  toolUseId: string;
  /** Set when a subagent makes the call. */
  agentId: string | null;
  /** For MCP tools: the server and where it is defined. */
  mcpServer: { name: string; source: string } | null;
}

/** What `AgentStartOptions.gate` makes of a tool call. */
export interface AgentGateDecision {
  decision: 'allow' | 'ask' | 'deny';
  /** Shown in the approval dialog, or told Claude when refused. */
  reason: string;
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
   * Looks at a tool call before Claude Code's own permission check:
   * `allow` runs it without asking (deny rules still apply), `ask` sends it
   * to `canUseTool` whatever allow rules and the mode say, `deny` refuses
   * it with the reason, `null` leaves it to Claude Code. Claude Code learns
   * it through a PreToolUse hook; used for `merge_pull_request` with
   * automerge.
   */
  gate?: (
    call: AgentToolCall,
  ) => AgentGateDecision | null | Promise<AgentGateDecision | null>;
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
  /**
   * Text appended to Claude Code's system prompt: instructions for the
   * sessions of this machine (`SESSION_INSTRUCTIONS_FILE`).
   */
  instructions?: string;
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
  /** The slash commands and skills of the process (its project's too). */
  supportedCommands(): Promise<SlashCommand[]>;
  /** Stops a task of the process (a subagent or background command). */
  stopTask(taskId: string): Promise<void>;
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
 * A one-shot, read-only Claude Code process: an independent review of a
 * session's changes. It may only read files (`Read`, `Grep`, `Glob`),
 * starts no MCP server, keeps no transcript and answers in `schema`.
 */
export interface AgentReviewOptions {
  cwd: string;
  additionalDirectories: string[];
  model: string;
  effort: ReviewEffort;
  /** The task, with the diff. */
  prompt: string;
  /** Appended to Claude Code's system prompt. */
  instructions: string;
  /** JSON schema of the answer. */
  schema: Record<string, unknown>;
  /** Aborts the process. */
  signal: AbortSignal;
}

/** What a review process ended with. */
export interface AgentReviewResult {
  /** The answer in the schema; `null` when it failed. */
  output: unknown;
  /** Why it failed; `null` on success. */
  error: string | null;
  /** Cumulative usage per model. */
  modelUsage: Record<string, ModelUsage>;
  durationMs: number;
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

  /**
   * Runs an independent review to its end (see {@link AgentReviewOptions});
   * rejects when the process cannot start or is aborted.
   */
  abstract review(options: AgentReviewOptions): Promise<AgentReviewResult>;
}

/** What a probe process can be asked. */
export interface AgentProbe {
  /** Models Claude Code offers for the logged-in account. */
  supportedModels(): Promise<ModelInfo[]>;
  /** The user's slash commands and skills, and Claude Code's own. */
  supportedCommands(): Promise<SlashCommand[]>;
  /** Plan rate limits (experimental SDK API, may change). */
  planUsage(): Promise<SDKControlGetUsageResponse>;
}
