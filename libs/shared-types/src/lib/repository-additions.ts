/**
 * Adding a repository to a session that already runs: by the user (the
 * control in the session details) or by Claude (the tool `add_repository`,
 * asked like any tool in the session's permission mode). The added repository gets
 * its own clone on the session branch, like the repositories the session
 * started with.
 */

/** Who added a repository to a running session. */
export type RepositoryAddedBy = 'user' | 'claude';

/**
 * Where an addition stands:
 * - `preparing`: the mirror is fetched, the clone made, the setup script
 *   runs;
 * - `failed`: the clone could not be made (nothing is left on disk);
 * - `held`: the clone exists, but its setup script failed or timed out, so
 *   Claude does not get it until the user runs the setup again or uses it
 *   anyway;
 * - `ready`: Claude works in it like in the session's other clones;
 * - `retired`: a clone removed after its pull request was merged or closed
 *   (any clone, also one the session started with, then without
 *   `addedAt`); the session goes on without it.
 */
export type RepositoryAdditionState =
  | 'preparing'
  | 'failed'
  | 'held'
  | 'ready'
  | 'retired';

/**
 * Whether a directory is a clone removed after its pull request
 * (`retired`): not a removed directory that stands in the way of
 * continuing the session.
 */
export function isRetiredClone(directory: {
  addition?: { state: RepositoryAdditionState } | null;
}): boolean {
  return directory.addition?.state === 'retired';
}

/** A repository added while the session ran (`SessionDirectoryDto.addition`). */
export interface RepositoryAdditionDto {
  /** `null`: a directory the session started with (then `retired`). */
  addedAt: string | null;
  by: RepositoryAddedBy;
  state: RepositoryAdditionState;
  /** Why it failed or is held; `null` otherwise. */
  error: string | null;
}

/**
 * Body of `POST /api/sessions/:id/repositories`: a registered repository
 * (also a local project), optionally with the branch to start from. The
 * web app registers repositories from GitHub, by URL and new projects
 * first, through the same routes as the new-session form.
 */
export interface AddSessionRepositoryRequest {
  repositoryId: string;
  /** Default: the repository's default branch. */
  baseBranch?: string;
}

/**
 * Where a repository Claude asks for comes from:
 * - `github`: one of the GitHub App installations' repositories;
 * - `url`: registered (or to be registered) by clone URL;
 * - `project`: a local project of this app.
 */
export type RepositoryAdditionSource = 'github' | 'url' | 'project';

/**
 * An `add_repository` call as the approval shows it. Text from the call
 * (names, the reason) is Claude's and untrusted: shown as plain text only.
 */
export interface RepositoryAdditionCall {
  source: RepositoryAdditionSource;
  /** `owner/name` (for a local project `local/<name>`). */
  repository: string;
  /** Clone URL for `url` (and GitHub's https URL for `github`). */
  url: string | null;
  /** Whether the app knows the repository already (registered). */
  registered: boolean;
  /** Branch to start from; `null`: the default branch. */
  baseBranch: string | null;
  /** The default branch, when known (shown when `baseBranch` is `null`). */
  defaultBranch: string | null;
  /** Why Claude needs the repository, as Claude wrote it. */
  reason: string;
}

/** Longest reason Claude may give for `add_repository`. */
export const MAX_ADDITION_REASON_LENGTH = 1000;
