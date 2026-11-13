import type { SessionDto, UsageTotals } from './session';

/**
 * Managing sessions: cleaning up their directories, archiving, deleting.
 *
 * Cleanup treats all directories of a session together; per directory the
 * owner chooses:
 * - `push`: push the session branch to the remote (no force; repositories
 *   with a remote), then remove the clone;
 * - `merge`: fast-forward the base branch of a local project's mirror to
 *   the session branch (local projects without remote), then remove it;
 * - `discard`: remove it;
 * - `keep`: leave it as it is.
 * A clone (or scratch directory) is removed only if nothing would be lost
 * by then, or the owner accepted the loss shown to them (`acceptLoss`).
 * Afterwards the session's history stays readable, but the session cannot
 * be resumed.
 */
export type CleanupAction = 'push' | 'merge' | 'discard' | 'keep';

/** What removing a directory would lose, read when asked. */
export interface DirectoryLoss {
  /**
   * Uncommitted (modified, staged, untracked and not ignored) files of a
   * clone; all files of a scratch directory.
   */
  files: string[];
  /** Total count; `files` lists at most the first 50. */
  fileCount: number;
  /** Commits on local branches that no remote branch has (clones). */
  unpushedCommits: { branch: string; sha: string; subject: string }[];
  /** Total count; the list holds at most 50. */
  unpushedCount: number;
  /** Entries in `git stash list`. */
  stashes: number;
  /** Disk usage of the directory in bytes, when known. */
  bytes: number | null;
  /** Nothing would be lost. */
  clean: boolean;
}

/** A directory of a session as the cleanup offers it. */
export interface CleanupDirectory {
  /** Position among the session's directories (0 = working directory). */
  position: number;
  kind: 'clone' | 'scratch' | 'directory';
  /** `owner/name` of the repository, or `Scratch`. */
  name: string;
  repositoryId: string | null;
  path: string;
  branch: string | null;
  baseBranch: string | null;
  /** The choices for this directory; `keep` is always among them. */
  actions: CleanupAction[];
  /** The session branch has commits its base does not have. */
  hasCommits: boolean;
  /** What removing it now would lose; `null` if it could not be read. */
  loss: DirectoryLoss | null;
  /**
   * What would still be lost after `push` or `merge` (uncommitted files,
   * stash entries, commits on other branches); `null` when the session
   * branch has nothing to push or merge.
   */
  lossAfterIntegration: DirectoryLoss | null;
  /** Why `loss` could not be read. */
  error: string | null;
}

/**
 * `GET /api/sessions/:id/cleanup`: what the cleanup would do. Only
 * directories that exist are listed.
 */
export interface CleanupPreview {
  sessionId: string;
  /**
   * Why the session cannot be cleaned up now (a turn runs, it is being
   * prepared); `null` if it can.
   */
  blocked: string | null;
  directories: CleanupDirectory[];
  /** Previews of dev servers that would be stopped. */
  previews: number;
}

/** One directory's choice in a cleanup. */
export interface CleanupChoice {
  position: number;
  action: CleanupAction;
  /** The owner saw and accepted what removing it loses. */
  acceptLoss?: boolean;
}

/** Body of `POST /api/sessions/:id/cleanup`; unnamed directories are kept. */
export interface CleanupRequest {
  directories: CleanupChoice[];
}

/** What happened to one directory. */
export interface CleanupOutcome {
  position: number;
  name: string;
  action: CleanupAction;
  /** `removed`, `kept` (by choice, or because work would be lost), `failed`. */
  result: 'removed' | 'kept' | 'failed';
  message: string;
}

/** Answer of the cleanup and of archiving. */
export interface CleanupResult {
  session: SessionDto;
  outcomes: CleanupOutcome[];
}

/**
 * Body of `POST /api/sessions/:id/archive`: archiving ends the session and
 * may clean up its directories in the same step.
 */
export interface ArchiveRequest {
  cleanup?: CleanupChoice[];
}

/** `GET /api/sessions/:id/deletion`: what deleting the session removes. */
export interface DeletionPreview {
  sessionId: string;
  /** Why it cannot be deleted now; `null` if it can. */
  blocked: string | null;
  /** Directories that still exist and are removed with it. */
  directories: CleanupDirectory[];
  /** Claude Code's transcript of the conversation exists. */
  transcript: boolean;
  /** Images attached to messages. */
  attachments: number;
  /** Snapshots of files Claude showed. */
  shownFiles: number;
  /** Pull requests on GitHub stay; the session's record of them goes. */
  pullRequests: number;
  /** Usage stays in the statistics (with the title and repositories). */
  usage: UsageTotals;
}

/** Body of `POST /api/sessions/:id/delete`. */
export interface DeleteSessionRequest {
  /** Must be `true`: the owner confirmed. */
  confirm: boolean;
  /** Needed when a directory holds work that would be lost. */
  acceptLoss?: boolean;
}
