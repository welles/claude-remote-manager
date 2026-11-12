/**
 * Repositories registered in the app. Each one has a shared bare clone under
 * `REPOS_DIR/<owner>/<name>`; sessions get their own worktrees of it under
 * `WORKTREES_DIR/<owner>/<name>/<session-slug>` on branch
 * `claude/<session-slug>`.
 */

/** A worktree of a repository as found on disk and in the database. */
export interface WorktreeDto {
  path: string;
  /** Checked-out branch (`claude/<slug>`), `null` if detached or unknown. */
  branch: string | null;
  /** Session the worktree belongs to; `null` for orphaned worktrees. */
  sessionId: string | null;
  sessionTitle: string | null;
  /** No session uses this worktree (left over or created by hand). */
  orphaned: boolean;
  /** A session expects the worktree here, but the directory is missing. */
  missing: boolean;
}

/** Background git work on a repository's shared clone. */
export type RepositoryActivity = 'cloning' | 'fetching';

export interface RepositoryDto {
  id: string;
  owner: string;
  name: string;
  /** `owner/name`. */
  fullName: string;
  cloneUrl: string;
  /** Default branch of the remote; `null` until cloned or if it is empty. */
  defaultBranch: string | null;
  /** Path of the shared bare clone. */
  localPath: string;
  /** Shell script run in every new worktree; `null` for none. */
  setupScript: string | null;
  /** When the clone was created; `null` while it is not cloned yet. */
  clonedAt: string | null;
  /** Last successful fetch (or clone). */
  fetchedAt: string | null;
  /** Error of the last clone or fetch; cleared by the next success. */
  lastError: string | null;
  /** Clone or fetch currently running. */
  activity: RepositoryActivity | null;
  /** Worktrees of the repository; filled in list and detail responses. */
  worktrees: WorktreeDto[];
  createdAt: string;
  updatedAt: string;
}

/** Response of `GET /api/repositories`, sorted by full name. */
export interface RepositoryListResponse {
  repositories: RepositoryDto[];
  /**
   * Directories under the worktrees directory that belong to no registered
   * repository; orphaned as well.
   */
  strayDirectories: string[];
}

/** Body of `POST /api/repositories`. Starts cloning in the background. */
export interface CreateRepositoryRequest {
  /**
   * `https://host/owner/name(.git)`, `ssh://…`, `git@host:owner/name.git`
   * or an absolute local path. Credentials in the URL are refused.
   */
  cloneUrl: string;
  setupScript?: string | null;
}

/** Body of `PATCH /api/repositories/:id`. */
export interface UpdateRepositoryRequest {
  /** New setup script; `null` or blank removes it. */
  setupScript: string | null;
}

/** Response of `GET /api/repositories/:id/branches`. */
export interface RepositoryBranchesResponse {
  defaultBranch: string | null;
  /** Branches of the remote as last fetched, sorted. */
  branches: string[];
}
