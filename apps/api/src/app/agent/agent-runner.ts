import type {
  AgentApprover,
  AgentCommand,
  AgentContextUsage,
  AgentEvent,
  AgentModel,
  AgentModelUsage,
  AgentPlanUsage,
} from './agent-events';
import type {
  ReviewEffort,
  SessionPermissionMode,
  UsageTotals,
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
  /**
   * The tool cannot run in this process, for this reason (e.g. the session
   * has no GitHub repository). Only engines that fix a thread's tools when
   * it starts get such tools (see `AgentEngine.fixedTools`), so the tool
   * stays when the session changes; they refuse a call with the reason
   * without asking anyone.
   */
  unavailable?: string;
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

/**
 * The Claude account a process runs with: Claude Code's configuration
 * directory with its login. Without one, a process uses the main directory
 * (the API's `CLAUDE_CONFIG_DIR` or `~/.claude`).
 */
export interface AgentAccount {
  /** Claude Code's configuration directory of the account. */
  configDir: string;
  /**
   * The main directory: its login may also come from
   * `CLAUDE_CODE_OAUTH_TOKEN`, which other accounts must not get.
   */
  main: boolean;
}

/** What a Claude Code process is started with. */
export interface AgentStartOptions {
  /** The account; the main one without. */
  account?: AgentAccount;
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
  approve: AgentApprover;
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
  /**
   * The rules among `allowedTools` the user allowed for the session
   * (`Allow for this session` of earlier approvals): an engine that matches
   * rules itself (Codex) reads them as exact, never as prefixes or
   * wildcards, since they are the literal command, file or tool approved.
   */
  sessionAllows?: string[];
  /** Variables added to the process environment (without app secrets). */
  env?: Record<string, string>;
  /** The app's own tools for this session. */
  tools?: AgentTool[];
  /**
   * The usage the app recorded for the session so far, per model: an
   * engine whose totals do not survive a restart reports its cumulative
   * usage on top of it (the usage tracker starts from it).
   */
  usageBaseline?: Record<string, UsageTotals>;
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
  /** What the process reports, in batches handled as a whole (one per
   * message of the engine); ends when the process ends. */
  readonly events: AsyncIterable<AgentEvent[]>;
  /** Sends a user message; it starts a turn or queues behind the running one. */
  send(message: AgentUserMessage): void;
  /** Stops the running turn. */
  interrupt(): Promise<void>;
  /** Context window usage, computed without extra API requests. */
  contextUsage(): Promise<AgentContextUsage>;
  /** The account's plan limits. */
  planUsage(): Promise<AgentPlanUsage>;
  /** Switches the permission mode of the running process. */
  setPermissionMode(mode: SessionPermissionMode): Promise<void>;
  /** Switches the model for the next requests; `null`: the default. */
  setModel(model: string | null): Promise<void>;
  /** The slash commands and skills of the process (its project's too). */
  supportedCommands(): Promise<AgentCommand[]>;
  /** Stops a task of the process (a subagent or background command). */
  stopTask(taskId: string): Promise<void>;
  /**
   * Makes further directories working directories of the running process
   * (also in the middle of a turn); Claude Code tells Claude about them
   * with its next request. Rejects when this Claude Code cannot do it.
   */
  addDirectories(directories: string[]): Promise<void>;
  /**
   * Ends the input and terminates the process. An engine whose processes
   * must not overlap (Codex: one thread, written from one home at a time)
   * returns a promise that resolves once the process has ended; the
   * session's next process starts after it.
   */
  close(): void | Promise<void>;
  /** The last lines Claude Code wrote to stderr, for error messages. */
  stderrTail(): string[];
}

/**
 * A one-shot, read-only process of an engine: an independent review of a
 * session's changes. It may only read (Claude Code: `Read`, `Grep`,
 * `Glob` in the session's directories; Codex: its read-only sandbox),
 * starts no MCP server and no hooks, keeps no transcript and answers in
 * `schema`.
 */
export interface AgentReviewOptions {
  /** The account (of the engine's provider); the main one without. */
  account?: AgentAccount;
  cwd: string;
  additionalDirectories: string[];
  /** `null`: the engine's default model. */
  model: string | null;
  effort: ReviewEffort;
  /** The task, with the diff. */
  prompt: string;
  /**
   * The reviewer's instructions (appended to Claude Code's system prompt,
   * Codex's developer instructions).
   */
  instructions: string;
  /** JSON schema of the answer. */
  schema: Record<string, unknown>;
  /** Aborts the process. */
  signal: AbortSignal;
}

/**
 * An engine refuses to run a review here (its read-only setup cannot be
 * kept, e.g. Codex without its sandbox or with command rules); the reason
 * is shown to the user. The app reviews with Claude Code instead.
 */
export class AgentReviewRefused extends Error {}

/** What a review process ended with. */
export interface AgentReviewResult {
  /** The answer in the schema; `null` when it failed. */
  output: unknown;
  /** Why it failed; `null` on success. */
  error: string | null;
  /** Cumulative usage per model. */
  modelUsage: AgentModelUsage;
  durationMs: number;
  /**
   * The model and effort the engine ran with, when it says (Codex names
   * its default model; an effort the model does not offer is lowered).
   */
  model?: string;
  effort?: ReviewEffort;
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
  abstract probe<T>(
    task: (probe: AgentProbe) => Promise<T>,
    account?: AgentAccount,
  ): Promise<T>;

  /**
   * Runs an independent review to its end (see {@link AgentReviewOptions});
   * rejects when the process cannot start, ends early or is aborted.
   */
  abstract review(options: AgentReviewOptions): Promise<AgentReviewResult>;

  /**
   * Why a review must not run with this engine for a session (its
   * read-only setup could be bypassed), `null` when it may; engines
   * without such a check leave it out.
   */
  reviewBlocked?(options: {
    account?: AgentAccount;
    cwd: string;
  }): Promise<string | null>;
}

/** What a probe process can be asked. */
export interface AgentProbe {
  /** Models Claude Code offers for the logged-in account. */
  supportedModels(): Promise<AgentModel[]>;
  /** The user's slash commands and skills, and Claude Code's own. */
  supportedCommands(): Promise<AgentCommand[]>;
  /** Plan rate limits (experimental SDK API, may change). */
  planUsage(): Promise<AgentPlanUsage>;
}
