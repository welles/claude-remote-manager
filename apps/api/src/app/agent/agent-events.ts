import type {
  ModelOption,
  SessionEventInput,
  SlashCommandOption,
  UsageTotals,
} from '@claude-remote-manager/shared-types';

/**
 * The engine-neutral model of what an agent process reports. Every engine
 * (Claude Code, Codex) is an adapter that turns its own protocol into these
 * events; the session core only knows them.
 */

/** An image the agent read or wrote, to show in the conversation. */
export type AgentImage =
  | {
      kind: 'read';
      toolUseId: string;
      path: string;
      data: Buffer;
    }
  | { kind: 'write'; toolUseId: string; path: string };

/** A slash command or skill the process offers. */
export type AgentCommand = SlashCommandOption;

/** A model the engine offers (`value` `null`: the engine's default). */
export type AgentModel = ModelOption;

/**
 * One limit window of the account (5 hours, a week, a per-model week, …)
 * as reported during a turn.
 */
export interface AgentRateLimit {
  /** e.g. `five_hour`, `seven_day`; `null` when not named. */
  window: string | null;
  status: 'allowed' | 'allowed_warning' | 'rejected' | null;
  /** Used share in percent (0-100), when known. */
  utilization: number | null;
  /** When it resets (ISO 8601), when known. */
  resetsAt: string | null;
}

/** One window of the account's plan usage, read on request. */
export interface AgentPlanWindow {
  /** e.g. `five_hour`, `seven_day`, `model:Fable`. */
  window: string;
  /** Shown name, for windows the app has no label for. */
  label: string | null;
  utilization: number | null;
  resetsAt: string | null;
}

/** The account's plan usage, read on request. */
export interface AgentPlanUsage {
  subscriptionType: string | null;
  /** `null` when the engine cannot tell the limits for this account. */
  windows: AgentPlanWindow[] | null;
}

/** How full the context window is. */
export interface AgentContextUsage {
  usedTokens: number;
  maxTokens: number;
  /** Percent (0-100). */
  percentage: number;
  /** The model the numbers are for. */
  model: string;
}

/** Cumulative usage of the process per model (the session subtracts). */
export type AgentModelUsage = Record<string, UsageTotals>;

/** The end of a turn. */
export interface AgentTurnResult {
  /** `success`, or why it ended early (e.g. `error_max_turns`). */
  subtype: string;
  isError: boolean;
  /** The final text of a successful turn. */
  text: string | null;
  errors: string[];
  durationMs: number;
  numTurns: number;
  usage: AgentModelUsage;
  /** The engine's ID of the conversation, when it says. */
  engineSessionId: string | null;
  /** Messages the process has queued behind this turn. */
  queuedTurns: number;
}

export type AgentEvent =
  /** The process is ready: the conversation's ID and its settings. */
  | {
      type: 'started';
      engineSessionId: string;
      permissionMode: string | null;
      /** Commands that only work in a terminal (not offered). */
      terminalCommands: string[];
    }
  /** The commands of the process changed. */
  | { type: 'commands'; commands: AgentCommand[] }
  /** Background tasks (subagents, commands) that run now, by ID. */
  | { type: 'background'; taskIds: string[] }
  /** The main agent produces output (a turn runs, also one it started). */
  | { type: 'activity' }
  /** The agent changed its permission mode itself (e.g. plan mode). */
  | { type: 'mode'; mode: string }
  /** A limit window of the account, as reported during a turn. */
  | { type: 'rate-limit'; limit: AgentRateLimit }
  /** The account's usage limit rejected the turn's request. */
  | { type: 'limit-hit' }
  /** A suggestion for the user's next message (session events). */
  | { type: 'suggestion'; events: SessionEventInput[] }
  /**
   * Conversation output: events for the log, the transcript entry they
   * follow (`anchor`), images seen, and whether the context grew.
   */
  | {
      type: 'output';
      events: SessionEventInput[];
      anchor: string | null;
      images: AgentImage[];
      contextChanged: boolean;
    }
  /** The turn ended. */
  | ({ type: 'result' } & AgentTurnResult);

/**
 * A stored conversation entry, for the session's history: the events it
 * shows and whether it is a message the user typed.
 */
export interface AgentHistoryEntry {
  /** The engine's ID of the entry (the client's ID for user messages). */
  uuid: string;
  isUserMessage: boolean;
  events: SessionEventInput[];
}

/** A permission rule: a tool and optionally what it applies to. */
export interface AgentPermissionRule {
  toolName: string;
  ruleContent?: string;
}

/**
 * A change of what the agent may do without asking, as an engine suggests
 * it for a request or the app applies it with an approval.
 */
export type AgentPermissionUpdate =
  | {
      type: 'addRules';
      rules: AgentPermissionRule[];
      behavior: 'allow' | 'deny' | 'ask';
      destination: string;
    }
  | { type: 'addDirectories'; directories: string[]; destination: string }
  | { type: 'setMode'; mode: string; destination: string }
  /** Something else the engine suggested; never applied by the app. */
  | { type: 'other'; raw: unknown };

/** A tool use the agent asks the app to decide. */
export interface AgentApprovalCall {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  /** The engine's sentence for it, e.g. "Claude wants to run …". */
  title: string | null;
  description: string | null;
  displayName: string | null;
  decisionReason: string | null;
  blockedPath: string | null;
  /** Set when a subagent asks. */
  agentId: string | null;
  /** For MCP tools: the server and where it is defined (`sdk`: ours). */
  mcpServer: { name: string; source: string } | null;
  /** The engine's suggestions for not asking again. */
  suggestions: AgentPermissionUpdate[];
  /** The engine says not to offer "don't ask again" for this request. */
  suppressAlwaysAllow: boolean;
  signal: AbortSignal;
}

/** The app's answer to an approval call. */
export type AgentApprovalResult =
  | {
      behavior: 'allow';
      /** The input to run the tool with (e.g. answers to questions). */
      updatedInput?: Record<string, unknown>;
      /** Applied to the session (e.g. allow rules, a mode switch). */
      updatedPermissions?: AgentPermissionUpdate[];
    }
  | {
      behavior: 'deny';
      /** Told to the agent. */
      message: string;
      /** The turn ends. */
      interrupt?: boolean;
    };

/** Decides the tool uses an agent asks about. */
export type AgentApprover = (
  call: AgentApprovalCall,
) => Promise<AgentApprovalResult>;
