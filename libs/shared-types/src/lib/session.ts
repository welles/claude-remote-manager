import type { MessageReferenceRequest } from './github-references';
import type { PendingRequestSummary } from './pending-requests';
import type { PullRequestAutomationDto } from './pr-automation';
import type { PreviewDto } from './previews';
import type { RepositoryAdditionDto } from './repository-additions';
/**
 * Lifecycle of a session as shown in the UI. The Claude Code process is an
 * internal detail: it is closed when idle or when the server stops and
 * restarted (resumed) with the next message without a status change.
 *
 * - `preparing`: the session's clones (or scratch directory) are being
 *   created and the setup scripts run; the first message goes to Claude
 *   afterwards. Messages are refused until then. Progress arrives as
 *   `prepare.progress`, `setup.output` and `setup.result` events. Ends in
 *   `running`; in `failed` if a clone could not be created (all of the
 *   session's directories are removed again then); or in `waiting` with
 *   `pendingMessage` set if a setup script failed.
 * - `running`: Claude is working on a turn.
 * - `waiting`: waits for the user; `waitingFor` (see {@link
 *   SessionWaitingFor}) says for what. With `waitingFor: 'permission'` a
 *   turn is in progress but blocked on an approval request (or a question,
 *   or a plan to approve); Stop interrupts it and new messages are queued,
 *   as while `running`.
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
 * What a `waiting` session waits for:
 * - `message`: the next user message (the turn is over);
 * - `permission`: the answer to an approval request, question or plan of
 *   the running turn (`GET /api/sessions/:id/permission-requests`);
 * - `setup`: a decision about the first message, held back because a
 *   setup script failed (`pendingMessage` is set): send it anyway, run the
 *   failed setup scripts again, or end the session.
 */
export type SessionWaitingFor = 'message' | 'permission' | 'setup';

/**
 * Whether a session is blocked on the user: it waits for an answer to an
 * approval request, question or plan (`waitingFor: 'permission'`), or for a
 * decision about the first message after a failed setup script
 * (`'setup'`). A session whose turn finished and that waits for the next
 * message does not count. Used for the app icon's badge (API and web app)
 * and the session list's "Needs you" filter, so that they always agree.
 */
export function needsUser(
  session: Pick<SessionDto, 'status' | 'waitingFor'>,
): boolean {
  return (
    session.status === 'waiting' &&
    (session.waitingFor === 'permission' || session.waitingFor === 'setup')
  );
}

/**
 * Permission modes a session may use. Mirrors the Agent SDK's modes without
 * `bypassPermissions`, which this app never uses. In `auto` a model
 * classifier of Claude Code approves or denies tool uses and asks the user
 * only when it cannot decide; some calls always ask the user (see
 * `PermissionModeOverride` and the README).
 */
export type SessionPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'auto'
  | 'plan'
  | 'dontAsk';

export const SESSION_PERMISSION_MODES: readonly SessionPermissionMode[] = [
  'default',
  'acceptEdits',
  'auto',
  'plan',
  'dontAsk',
];

/**
 * The session's Claude Code process runs in another mode than the chosen
 * one (`SessionDto.permissionMode` is `auto`):
 * - `auto_unavailable`: Claude Code cannot use auto mode here (plan,
 *   model or settings) and fell back to `default`;
 * - `autofix`: an Autofix run is going; it works on untrusted GitHub
 *   content and therefore runs in `default` until its turn ends.
 */
export interface PermissionModeOverride {
  /** The mode in effect. */
  mode: SessionPermissionMode;
  reason: 'auto_unavailable' | 'autofix';
}

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
 * Setup script of a session clone: `none` without script, `pending` before it
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
 * Kind of a session directory:
 * - `clone`: the session's own clone of a registered repository (or local
 *   project) on the session branch;
 * - `scratch`: an empty directory of its own, without git;
 * - `directory`: a plain directory (sessions created before session clones
 *   existed).
 */
export type SessionDirectoryKind = 'clone' | 'scratch' | 'directory';

/**
 * A directory of a session. The first (`role: 'main'`) is the working
 * directory; the others are additional directories Claude may access.
 */
export interface SessionDirectoryDto {
  role: 'main' | 'additional';
  kind: SessionDirectoryKind;
  path: string;
  state: SessionDirectoryState;
  /**
   * Repository of a clone; `github` when it is registered from GitHub (push
   * and pull requests through the GitHub App).
   */
  repository: {
    id: string;
    fullName: string;
    local: boolean;
    github: boolean;
  } | null;
  /** Branch of the clone, `claude/<session-slug>`. */
  branch: string | null;
  /** Branch of the mirror the clone's branch was created from. */
  baseBranch: string | null;
  /**
   * Commit the branch started at, for diffs against the session's starting
   * point; `null` for empty repositories and other directories.
   */
  baseCommit: string | null;
  setupStatus: SetupStatus;
  /** Commit of the session branch last pushed (by button or by Claude). */
  pushedCommit: string | null;
  pushedAt: string | null;
  /**
   * Set for a repository added while the session ran; `null` for the
   * directories the session started with (absent from older servers).
   */
  addition?: RepositoryAdditionDto | null;
}

export type PullRequestState = 'open' | 'closed' | 'merged';

/** Who created a pull request: the user by button, or Claude by tool. */
export type PullRequestCreator = 'user' | 'claude';

/** A pull request of one of the session's clones. */
export interface PullRequestDto {
  id: number;
  repositoryId: string;
  /** `owner/name` of the repository. */
  repository: string;
  number: number;
  url: string;
  title: string;
  state: PullRequestState;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  createdBy: PullRequestCreator;
  openedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  /** When the state was last read from GitHub. */
  syncedAt: string;
  /** PR automation of this pull request (see `PullRequestAutomationDto`). */
  automation: PullRequestAutomationDto;
}

/**
 * Body of `POST /api/sessions/:id/repositories/:repositoryId/pull-requests`.
 * The session branch is pushed first if GitHub does not have its latest
 * commit.
 */
export interface CreatePullRequestRequest {
  /** Default: the session title. */
  title?: string;
  body?: string;
  /** Default: the branch the session clone started from. */
  base?: string;
  draft?: boolean;
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
  /** Mode chosen for the session (see `permissionModeOverride`). */
  permissionMode: SessionPermissionMode;
  /**
   * Set while the session's Claude Code process runs in another mode than
   * `permissionMode` (only for `auto`); `null` otherwise, also while no
   * process runs. Absent from older servers.
   */
  permissionModeOverride?: PermissionModeOverride | null;
  status: SessionStatus;
  /** Set exactly when `status` is `waiting`. */
  waitingFor: SessionWaitingFor | null;
  /**
   * With `waitingFor: 'permission'`: what the pending approval requests
   * ask for (kind and count, no details), for the session list; `null`
   * otherwise. Absent from older servers.
   */
  pendingRequests?: PendingRequestSummary | null;
  /**
   * Readable unique name, used for the session's directories and branches;
   * `null` for sessions created before session clones existed.
   */
  slug: string | null;
  /**
   * The first message while it has not been sent to Claude: during the
   * preparation, and afterwards if a setup script failed.
   */
  pendingMessage: string | null;
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
  /** Pull requests of the session's clones, oldest first. */
  pullRequests: PullRequestDto[];
  /**
   * When autoclose ended the session after its pull requests were merged
   * or closed. Clones still `ready` afterwards were kept because they hold
   * work that is not on GitHub (see `CloneLossReport`).
   */
  autoclosedAt: string | null;
  /**
   * Previews of the session's dev servers that are not stopped, oldest
   * first (see `PreviewDto`).
   */
  previews: PreviewDto[];
  /**
   * When the session was archived (hidden from the default list, ended,
   * history readable); `null` while it is not.
   */
  archivedAt: string | null;
}

/** A repository a new session works on. */
export interface SessionRepositoryRequest {
  repositoryId: string;
  /** Branch to start from; the repository's default branch if unset. */
  baseBranch?: string;
}

/**
 * Body of `POST /api/sessions`. A session works in a main repository (the
 * first entry of `repositories`, or `newProject`), plus any further
 * repositories; each gets its own clone on a new branch `claude/<slug>`.
 * Or, with `scratch`, in an empty directory of its own without git.
 */
export interface CreateSessionRequest {
  /**
   * First user message; sent once the session's directories are ready.
   * May be empty when images are attached.
   */
  prompt: string;
  /** Uploaded images (`POST /api/attachments`) for the first message. */
  attachmentIds?: string[];
  /** GitHub issues and pull requests referenced in the first message. */
  references?: MessageReferenceRequest[];
  title?: string;
  /** Model name or alias such as `sonnet`, `opus` or `haiku`. */
  model?: string;
  permissionMode?: SessionPermissionMode;
  /**
   * Repositories (and local projects) in order. Without `newProject` the
   * first one is the main repository (working directory).
   */
  repositories?: SessionRepositoryRequest[];
  /**
   * Create the local project `local/<name>` (a repository without remote)
   * and make it the main repository.
   */
  newProject?: { name: string };
  /** Work in an empty scratch directory without repository. */
  scratch?: boolean;
}

/**
 * Response of `GET /api/sessions?archived=`, newest first: without
 * `archived` the sessions that are not archived, `archived=only` the
 * archived ones, `archived=include` all.
 */
export interface SessionListResponse {
  sessions: SessionDto[];
}

/** Which sessions `GET /api/sessions` lists. */
export type SessionListFilter = 'exclude' | 'only' | 'include';

/**
 * Whether Claude works in a directory: those the session started with, and
 * added repositories once they are ready (not while they are prepared,
 * failed or held after a failed setup script).
 */
export function isActiveDirectory(
  directory: Pick<SessionDirectoryDto, 'addition'>,
): boolean {
  return !directory.addition || directory.addition.state === 'ready';
}

/**
 * A session can be resumed (sent a message) only while all its
 * directories exist and it is not archived; after its clones were cleaned
 * up its history stays readable. Repositories still being added (or whose
 * addition failed) do not stand in the way.
 */
export function canResume(
  session: Pick<SessionDto, 'directories' | 'archivedAt'>,
): boolean {
  return (
    session.archivedAt === null &&
    session.directories.every(
      (directory) =>
        !isActiveDirectory(directory) || directory.state === 'ready',
    )
  );
}
