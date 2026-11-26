import type { SessionDiffFile, SessionDiffLimits } from './session-diff';

/*
 * Commits of session branches: shown in the history when they appear
 * (`commits.added`), listed per clone on the changes page, and each with
 * its own diff (`GET /api/sessions/:id/diff/commit`).
 */

/** A file a commit changed, with its line counts (no content). */
export interface CommitFileStat {
  path: string;
  /** Previous path of a renamed or copied file. */
  oldPath: string | null;
  /** Binary content: no line counts (both 0). */
  binary: boolean;
  additions: number;
  deletions: number;
}

/** One commit, without its diff. */
export interface CommitSummary {
  sha: string;
  /** Parent commits; more than one for a merge commit. */
  parents: string[];
  /** First line of the message. */
  subject: string;
  /** The rest of the message after the subject, trimmed; may be empty. */
  body: string;
  authorName: string;
  /** Author date (ISO 8601). */
  authoredAt: string;
  /**
   * Changed files against the first parent, at most
   * {@link MAX_COMMIT_FILES}; none for a merge commit.
   */
  files: CommitFileStat[];
  /** All changed files, also those beyond the limit. */
  fileCount: number;
  additions: number;
  deletions: number;
}

/** Files listed per commit in a `commits.added` event or a commit list. */
export const MAX_COMMIT_FILES = 50;
/** Commits listed per `commits.added` event or per clone on the changes page. */
export const MAX_LISTED_COMMITS = 50;

/** Response of `GET /api/sessions/:id/diff/commit`: one commit's diff. */
export interface CommitDiffResponse {
  repositoryId: string;
  /** `owner/name`. */
  repository: string;
  branch: string | null;
  /**
   * The commit, with the totals of the whole diff; its `files` are empty
   * (the files are listed below).
   */
  commit: CommitSummary;
  /**
   * What the commit is compared with: its first parent, or `null` for a
   * root commit (compared with the empty tree).
   */
  parent: string | null;
  files: SessionDiffFile[];
  fileCount: number;
  limits: SessionDiffLimits;
}
