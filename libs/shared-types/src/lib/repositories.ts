/**
 * Repositories registered in the app. Each one has a mirror: a bare
 * repository under `<workspace>/repos/<owner>/<name>` that is cloned once
 * and then only fetched; nobody works in it. Every session gets its own
 * complete clone of it (objects hardlinked) under
 * `<workspace>/sessions/<session-slug>/<owner>/<name>` on branch
 * `claude/<session-slug>`.
 *
 * Local projects are repositories without a remote (owner `local`): their
 * mirror is the project's main repository.
 */

/** A session clone of a repository as found on disk and in the database. */
export interface SessionCloneDto {
  path: string;
  /** Session branch (`claude/<slug>`); `null` if unknown. */
  branch: string | null;
  /** Session the clone belongs to; `null` for orphaned clones. */
  sessionId: string | null;
  sessionTitle: string | null;
  /** No session uses this clone (left over or created by hand). */
  orphaned: boolean;
  /** A session expects the clone here, but the directory is missing. */
  missing: boolean;
}

/** Background git work on a repository's mirror. */
export type RepositoryActivity = 'cloning' | 'fetching';

export interface RepositoryDto {
  id: string;
  owner: string;
  name: string;
  /** `owner/name`. */
  fullName: string;
  /** URL of the remote; `null` for a local project without remote. */
  cloneUrl: string | null;
  /** Local project: no remote, the mirror is the main repository. */
  local: boolean;
  /**
   * Registered from GitHub: fetched, cloned and pushed with the GitHub
   * App's installation tokens. `null` for repositories registered by clone
   * URL (they use the server's own git credentials) and local projects.
   */
  github: {
    repositoryId: number;
    installationId: number;
    htmlUrl: string;
  } | null;
  /** Default branch; `null` until cloned or if the remote is empty. */
  defaultBranch: string | null;
  /** Path of the mirror (bare repository). */
  localPath: string;
  /** Shell script run in every new session clone; `null` for none. */
  setupScript: string | null;
  /** When the mirror was created; `null` while it does not exist yet. */
  clonedAt: string | null;
  /** Last successful fetch (or clone) of the mirror. */
  fetchedAt: string | null;
  /** Error of the last clone or fetch; cleared by the next success. */
  lastError: string | null;
  /** Clone or fetch currently running. */
  activity: RepositoryActivity | null;
  /** Session clones of the repository. */
  clones: SessionCloneDto[];
  createdAt: string;
  updatedAt: string;
}

/** Response of `GET /api/repositories`, sorted by full name. */
export interface RepositoryListResponse {
  repositories: RepositoryDto[];
  /**
   * Directories under the sessions and scratch directories that no session
   * uses and that belong to no registered repository.
   */
  strayDirectories: string[];
}

/**
 * Body of `POST /api/repositories`: a GitHub repository, a clone URL (both
 * cloned in the background) or the name of a new local project.
 */
export type CreateRepositoryRequest =
  | {
      /**
       * A repository from `GET /api/github/repositories`. Registering is
       * idempotent: an already registered repository is returned.
       */
      githubRepositoryId: number;
      setupScript?: string | null;
    }
  | {
      /**
       * `https://host/owner/name(.git)`, `ssh://…`, `git@host:owner/name.git`
       * or an absolute local path. Credentials in the URL are refused.
       */
      cloneUrl: string;
      setupScript?: string | null;
    }
  | {
      /** New local project `local/<projectName>` without remote. */
      projectName: string;
      setupScript?: string | null;
    };

/** Body of `PATCH /api/repositories/:id`. */
export interface UpdateRepositoryRequest {
  /** New setup script; `null` or blank removes it. */
  setupScript: string | null;
}

/** Response of `GET /api/repositories/:id/branches`. */
export interface RepositoryBranchesResponse {
  defaultBranch: string | null;
  /** Branches of the mirror (the remote's as last fetched), sorted. */
  branches: string[];
}
