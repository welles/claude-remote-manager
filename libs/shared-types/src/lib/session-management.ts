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
   * prepared, it has not ended); `null` if it can.
   */
  blocked: string | null;
  /**
   * Why it cannot be archived now; `null` if it can (archiving ends a
   * session that waits).
   */
  archiveBlocked: string | null;
  directories: CleanupDirectory[];
  /**
   * The session's branches on the remotes of its repositories (also of
   * clones removed already), which the cleanup can delete.
   */
  remoteBranches: RemoteBranch[];
  /** Previews of dev servers that would be stopped. */
  previews: number;
}

/**
 * The session branch of a clone on the repository's remote, read fresh
 * (the mirror is fetched) for the preview.
 */
export interface RemoteBranch {
  /** Position of the clone among the session's directories. */
  position: number;
  /** `owner/name` of the repository. */
  name: string;
  branch: string;
  /** Commit the branch points to on the remote; `null` if unknown. */
  commit: string | null;
  /**
   * Commits that only this branch has: no other branch or tag of the
   * remote has them, and no merged pull request (squash, rebase) brought
   * them in. Deleting the branch loses them.
   */
  unmergedCount: number;
  /** Pull request (GitHub) that merged exactly this commit. */
  mergedBy: number | null;
  /** Deleting it loses nothing: offered checked. */
  safe: boolean;
  /**
   * Why it cannot be deleted now: an open pull request from the branch
   * (deleting would close it), or the check failed.
   */
  blocked: string | null;
}

/** One directory's choice in a cleanup. */
export interface CleanupChoice {
  position: number;
  action: CleanupAction;
  /** The owner saw and accepted what removing it loses. */
  acceptLoss?: boolean;
}

/** Deleting a session branch on the remote. */
export interface RemoteBranchChoice {
  /** Position of the clone (see {@link RemoteBranch}). */
  position: number;
  /** The owner accepted losing the commits only this branch has. */
  acceptLoss?: boolean;
}

/**
 * Body of `POST /api/sessions/:id/cleanup`; unnamed directories are kept,
 * unnamed remote branches too.
 */
export interface CleanupRequest {
  directories: CleanupChoice[];
  /** Session branches to delete on the remote (after the directories). */
  remoteBranches?: RemoteBranchChoice[];
}

/** What happened to a session branch on the remote. */
export interface RemoteBranchOutcome {
  position: number;
  name: string;
  branch: string;
  /**
   * `deleted`, `kept` (it would now lose commits not accepted, or close an
   * open pull request), `failed`.
   */
  result: 'deleted' | 'kept' | 'failed';
  message: string;
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
  remoteBranches: RemoteBranchOutcome[];
}

/**
 * Body of `POST /api/sessions/:id/archive`: archiving ends the session and
 * may clean up its directories and remote branches in the same step.
 */
export interface ArchiveRequest {
  cleanup?: CleanupChoice[];
  remoteBranches?: RemoteBranchChoice[];
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
