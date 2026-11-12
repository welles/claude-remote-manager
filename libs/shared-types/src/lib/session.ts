/**
 * Lifecycle of a session as shown in the UI.
 *
 * - `running`: Claude is working on a turn.
 * - `waiting`: the Claude Code process is alive and waits for the next user
 *   message (later also for a permission answer).
 * - `finished`: no process is running (idle timeout, server restart or the
 *   process ended normally). Sending a message resumes the session.
 * - `failed`: the process ended with an error. Sending a message tries to
 *   resume the session.
 */
export type SessionStatus = 'running' | 'waiting' | 'finished' | 'failed';

/**
 * Permission modes a session may use. Mirrors the Agent SDK's modes without
 * `bypassPermissions`, which this app never uses.
 */
export type SessionPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk';

export const SESSION_PERMISSION_MODES: readonly SessionPermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
];

/** Token counts and theoretical API cost (USD), summed over requests. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
}

/** Usage of the context window of a session, as reported by Claude Code. */
export interface ContextUsage {
  /** Model the usage was computed for. */
  model: string;
  /** Tokens currently in the context window. */
  usedTokens: number;
  /** Window the usage is measured against (may be the auto-compact window). */
  maxTokens: number;
  /** `usedTokens / maxTokens` in percent, 0-100 (can exceed 100). */
  percentage: number;
  /** When the value was captured (ISO 8601). */
  updatedAt: string;
}

/** A session as returned by the REST API and pushed over the WebSocket. */
export interface SessionDto {
  /** ID of the session in this app (UUID). */
  id: string;
  /**
   * Claude Code session ID (UUID), used to resume the session. `null` until
   * Claude Code reported it for the first time.
   */
  sdkSessionId: string | null;
  title: string | null;
  /** Model requested for the session; `null` uses Claude Code's default. */
  model: string | null;
  permissionMode: SessionPermissionMode;
  status: SessionStatus;
  /** Working directory (the main repository's worktree in later steps). */
  cwd: string;
  /** Further directories the session may access (further repositories). */
  additionalDirectories: string[];
  /** Last error message, e.g. why the session failed. */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /** Summed usage of all requests of the session. */
  usage: UsageTotals;
  /** Latest known context window usage; only while this server knows it. */
  context: ContextUsage | null;
}

/** Body of `POST /api/sessions`. */
export interface CreateSessionRequest {
  /** First user message; starts the session. */
  prompt: string;
  title?: string;
  /** Model name or alias such as `sonnet`, `opus` or `haiku`. */
  model?: string;
  permissionMode?: SessionPermissionMode;
}

/** Response of `GET /api/sessions`, newest first. */
export interface SessionListResponse {
  sessions: SessionDto[];
}
