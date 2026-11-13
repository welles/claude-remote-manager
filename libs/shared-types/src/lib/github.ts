/**
 * GitHub integration through the app's own GitHub App. The app is installed
 * on the user's account and on organizations; each installation decides
 * which repositories the app can access.
 */

/** An installation of the GitHub App on an account or organization. */
export interface GitHubInstallationDto {
  id: number;
  /** Login of the account or organization. */
  account: string;
  accountType: 'User' | 'Organization' | string;
  /** `all` repositories of the account, or only `selected` ones. */
  repositorySelection: 'all' | 'selected' | string;
  /** Repositories the installation can access; `null` if unknown. */
  repositoryCount: number | null;
  /** Page on GitHub to change the installation (repositories, removal). */
  settingsUrl: string | null;
  /** Why the installation's repositories could not be listed. */
  error: string | null;
}

/** Response of `GET /api/github/status`. */
export interface GitHubStatusDto {
  /** App ID and a readable private key are configured. */
  configured: boolean;
  /** Why GitHub is not configured or not usable. */
  problem: string | null;
  appId: string | null;
  /** Name and slug of the app as GitHub reports them. */
  appName: string | null;
  appSlug: string | null;
  appUrl: string | null;
  /** Page to install the app on further accounts or organizations. */
  installUrl: string | null;
  installations: GitHubInstallationDto[];
  /** GitHub could not be asked (unreachable, rate limit, ...). */
  error: string | null;
}

/** A repository one of the installations can access. */
export interface GitHubRepositoryDto {
  /** GitHub's repository ID (stable across renames). */
  id: number;
  installationId: number;
  owner: string;
  name: string;
  /** `owner/name`. */
  fullName: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string | null;
  description: string | null;
  pushedAt: string | null;
  htmlUrl: string;
  /** ID of the registered repository in this app, if registered. */
  registeredRepositoryId: string | null;
}

/** Response of `GET /api/github/repositories?query=&page=&perPage=`. */
export interface GitHubRepositoryListResponse {
  repositories: GitHubRepositoryDto[];
  /** Matches of the query over all installations. */
  total: number;
  page: number;
  perPage: number;
  /** When the list was fetched from GitHub (it is cached briefly). */
  fetchedAt: string;
  /** Installations whose repositories could not be listed. */
  errors: string[];
}

/**
 * Body of `POST /api/repositories/:id/github`: gives a local project a
 * GitHub repository as remote and pushes its branches there. `create` makes
 * a new repository in an account or organization the app is installed on;
 * `attach` uses an existing, empty repository the app can access.
 */
export type ConnectGitHubRequest =
  | {
      mode: 'create';
      /** Account or organization login (an installation's account). */
      owner: string;
      /** Repository name; the project's name if omitted. */
      name?: string;
      /** Default: private. */
      private?: boolean;
      description?: string;
    }
  | {
      mode: 'attach';
      /** GitHub repository ID from `GET /api/github/repositories`. */
      githubRepositoryId: number;
    };
