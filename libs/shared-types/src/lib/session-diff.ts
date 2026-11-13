import type { FileDiff } from './diffs';

/*
 * Diff of a whole session (`GET /api/sessions/:id/diff`): what each of its
 * session clones changed against the merge base with its base branch, per file,
 * with uncommitted changes and untracked (not ignored) files. Also used by
 * the cleanup of sessions.
 */

/**
 * Whether the content (`hunks`) of a file of a session diff is included:
 * - `included`: the hunks are there (with `truncated` when cut at the
 *   limit of a file loaded on its own);
 * - `omitted`: left out because the response reached its total limit;
 * - `too_large`: more lines than a file may have in the whole-session
 *   diff.
 * Omitted and too large files are loaded one at a time with
 * `GET /api/sessions/:id/diff/file`.
 */
export type SessionDiffContent = 'included' | 'omitted' | 'too_large';

export interface SessionDiffFile extends FileDiff {
  content: SessionDiffContent;
}

/**
 * What a session diff compares a clone against:
 * - `merge_base`: the merge base of `HEAD` and the base branch as the clone
 *   knows it (`origin/<base branch>`), like a pull request: changes merged
 *   or rebased in from the base branch are not the session's;
 * - `start_commit`: the commit the session branch started at, when there
 *   is no such merge base (`fallbackReason` says why).
 */
export interface DiffComparison {
  commit: string;
  basis: 'merge_base' | 'start_commit';
  /** Ref of the base branch the merge base was taken with, e.g. `origin/main`. */
  ref: string | null;
  fallbackReason: string | null;
}

/**
 * What a session clone changed: the working tree (with staged and
 * untracked, not ignored files) against {@link DiffComparison}.
 */
export interface RepositoryDiff {
  repositoryId: string;
  /** `owner/name`. */
  repository: string;
  path: string;
  branch: string | null;
  baseBranch: string | null;
  /** The commit the session branch started at. */
  startCommit: string | null;
  /** What the diff compares against; `null` when unavailable. */
  comparison: DiffComparison | null;
  /** Commit checked out in the clone (`HEAD`). */
  headCommit: string | null;
  /** `unavailable`: no diff (clone removed, no base commit, git failed). */
  state: 'ok' | 'unavailable';
  message: string | null;
  /** Changed files, at most {@link SessionDiffLimits.maxFiles}. */
  files: SessionDiffFile[];
  /** All changed files, also those beyond the limit. */
  fileCount: number;
  additions: number;
  deletions: number;
}

export interface SessionDiffLimits {
  /** Files listed per repository. */
  maxFiles: number;
  /** Diff lines of one file in the session diff. */
  maxFileLines: number;
  /** Diff lines of all files of the response together. */
  maxTotalLines: number;
  /** Diff lines of one file loaded on its own. */
  maxSingleFileLines: number;
}

/** Response of `GET /api/sessions/:id/diff`. */
export interface SessionDiffResponse {
  sessionId: string;
  /**
   * Every repository of the session in order; uncommitted changes and
   * untracked (not ignored) files are included.
   */
  repositories: RepositoryDiff[];
  limits: SessionDiffLimits;
}
