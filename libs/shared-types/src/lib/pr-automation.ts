/**
 * PR automation per pull request of a session (both switches off by
 * default):
 * - autofix: a failed CI check of the pull request's head commit, or new
 *   review feedback from someone with write access to the repository,
 *   continues the session with that content (as untrusted context);
 *   Claude may then push exactly the session branch without asking (the
 *   app pushes it, without force); once the head commit passed all
 *   checks and is approved, the session is told so (no attempt);
 * - autoclose: when the pull request is merged or closed and the session
 *   has no open pull request left, the session ends and its clones are
 *   removed, except clones with work that is not on GitHub.
 */

/**
 * What started an autofix run; `ready`: the session was told that the
 * pull request passed all checks and is approved (no attempt).
 */
export type AutofixTrigger = 'ci' | 'review' | 'ci+review' | 'ready';

export interface PullRequestAutomationDto {
  autofix: boolean;
  autoclose: boolean;
  /** Autofix runs started for this pull request (survives restarts). */
  attempts: number;
  /** Runs allowed; afterwards the owner is notified instead. */
  maxAttempts: number;
  /** The limit stopped a run (cleared by a reset or a higher limit). */
  gaveUp: boolean;
  /** An autofix run is going on in the session. */
  running: boolean;
  lastRunAt: string | null;
  lastTrigger: AutofixTrigger | null;
}

/** Attempt limits a user may choose. */
export const AUTOFIX_MAX_ATTEMPTS_RANGE = { min: 1, max: 20 } as const;
export const AUTOFIX_DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Body of `PATCH /api/sessions/:id/pull-requests/:pullRequestId/automation`;
 * every field is optional.
 */
export interface UpdatePullRequestAutomationRequest {
  autofix?: boolean;
  autoclose?: boolean;
  maxAttempts?: number;
  /** Sets the attempt count back to 0. */
  resetAttempts?: boolean;
}

/**
 * What deleting a session clone would lose: changes that are not on
 * GitHub. `GET /api/sessions/:id/repositories/:repositoryId/clone-loss`.
 */
export interface CloneLossReport {
  repositoryId: string;
  repository: string;
  path: string;
  /** Uncommitted (modified, staged, untracked and not ignored) files. */
  uncommittedFiles: string[];
  /** Total count; `uncommittedFiles` lists at most the first 50. */
  uncommittedCount: number;
  /** Commits on local branches that no remote branch has. */
  unpushedCommits: { branch: string; sha: string; subject: string }[];
  /** Total count; the list holds at most 50. */
  unpushedCount: number;
  /** Entries in `git stash list`. */
  stashes: number;
  /** Nothing would be lost. */
  clean: boolean;
}

/** Body of `POST /api/sessions/:id/repositories/:repositoryId/discard-clone`. */
export interface DiscardCloneRequest {
  /** Must be `true`: the user confirmed the loss shown to them. */
  confirm: boolean;
}
