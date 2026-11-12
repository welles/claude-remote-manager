/**
 * Lifecycle of a session as shown in the UI. The Claude Code process is an
 * internal detail: it is closed when idle or when the server stops and
 * restarted (resumed) with the next message without a status change.
 *
 * - `preparing`: the session's worktrees (or new project) are being created
 *   and the setup scripts run; the first message goes to Claude afterwards.
 *   Further messages are refused until then. Progress arrives as
 *   `prepare.progress`, `setup.output` and `setup.result` events. Ends in
 *   `running`, or in `failed` if a worktree could not be created (all
 *   worktrees of the session are removed again then). A failing setup script
 *   does not fail the session.
 * - `running`: Claude is working on a turn.
 * - `waiting`: waits for the next user message (later also for a
 *   permission answer).
 * - `finished`: ended explicitly (later also by PR autoclose). Sending a
 *   message resumes the session.
 * - `failed`: the process could not start or ended with an error during a
 *   turn. Sending a message tries to resume the session.
 */
export type SessionStatus =
  | 'preparing'
  | 'running'
  | 'waiting'
  | 'finished'
  | 'failed';

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

/**
 * State of a session directory:
 * - `pending`: to be created during preparation;
 * - `ready`: exists and is used by the session;
 * - `failed`: could not be created;
 * - `removed`: was removed again (rollback of a failed preparation, or
 *   cleanup). A session with a directory that is not `ready` cannot continue.
 */
export type SessionDirectoryState = 'pending' | 'ready' | 'failed' | 'removed';

/**
 * Setup script of a worktree: `none` without script, `pending` before it
 * runs, then `running` and `succeeded`, `failed` (non-zero exit or could not
 * start), `timed_out`, or `skipped` (preparation stopped before it ran).
 */
export type SetupStatus =
  | 'none'
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'skipped';

/**
 * A directory of a session. The first (`role: 'main'`) is the working
 * directory; the others are additional directories Claude may access.
 *
 * - `worktree`: worktree of a registered repository on its own branch;
 * - `project`: a new project without repository (`git init` in
 *   `PROJECTS_DIR/<name>`), the session works directly in it;
 * - `directory`: a plain directory (sessions created before worktrees
 *   existed).
 */
export interface SessionDirectoryDto {
  role: 'main' | 'additional';
  kind: 'worktree' | 'project' | 'directory';
  path: string;
  state: SessionDirectoryState;
  /** Repository of a worktree. */
  repository: { id: string; fullName: string } | null;
  /** Name of a new project. */
  projectName: string | null;
  /** Branch of the worktree, `claude/<session-slug>`. */
  branch: string | null;
  /** Remote branch the worktree was created from. */
  baseBranch: string | null;
  /**
   * Commit the branch started at, for diffs against the session's starting
   * point; `null` for empty repositories and other directories.
   */
  baseCommit: string | null;
  setupStatus: SetupStatus;
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
  /**
   * Readable unique name, used for worktree directories and branches;
   * `null` for sessions created before worktrees existed.
   */
  slug: string | null;
  /** Directories of the session; the first is the working directory. */
  directories: SessionDirectoryDto[];
  /** Working directory: path of the first directory. */
  cwd: string;
  /** Paths of the other directories, in order. */
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

/** A repository a new session works on. */
export interface SessionRepositoryRequest {
  repositoryId: string;
  /** Remote branch to start from; the repository's default branch if unset. */
  baseBranch?: string;
}

/**
 * Body of `POST /api/sessions`. A session works either in a main
 * repository (the first entry of `repositories`) or in a new project
 * (`newProject`), plus any further repositories. Each repository gets its
 * own worktree on a new branch `claude/<slug>`.
 */
export interface CreateSessionRequest {
  /** First user message; sent once the worktrees are ready. */
  prompt: string;
  title?: string;
  /** Model name or alias such as `sonnet`, `opus` or `haiku`. */
  model?: string;
  permissionMode?: SessionPermissionMode;
  /**
   * Repositories in order. Without `newProject` the first one is the main
   * repository (working directory); the others are additional directories.
   */
  repositories?: SessionRepositoryRequest[];
  /** Start in a new, empty project: `git init` in `PROJECTS_DIR/<name>`. */
  newProject?: { name: string };
}

/** Response of `GET /api/sessions`, newest first. */
export interface SessionListResponse {
  sessions: SessionDto[];
}
