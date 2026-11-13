import type { GitHubAppCredentials } from './github-app-credentials';
import type { GitHubHttp } from './github-http';

/** Permissions an installation token can be narrowed to. */
export type GitHubPermission =
  | 'metadata'
  | 'contents'
  | 'pull_requests'
  | 'workflows'
  | 'administration'
  | 'issues'
  | 'checks'
  | 'statuses'
  | 'actions';

export type GitHubPermissionSet = Partial<
  Record<GitHubPermission, 'read' | 'write'>
>;

export interface InstallationTokenRequest {
  installationId: number;
  /**
   * Repositories the token may access; omitted only for listing an
   * installation's repositories (with `metadata: read`).
   */
  repositoryIds?: number[];
  permissions: GitHubPermissionSet;
  /**
   * Mint a new token instead of reusing a cached one, e.g. for a token
   * that is handed out and revoked afterwards.
   */
  fresh?: boolean;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  installationId: number;
  repositoryIds: number[] | null;
  permissions: GitHubPermissionSet;
}

/** Cached tokens are reused at most this long after minting. */
export const TOKEN_REUSE_MS = 10 * 60_000;
/** ... and only while they are valid at least this much longer. */
const MIN_REMAINING_MS = 5 * 60_000;

function cacheKey(request: InstallationTokenRequest): string {
  const ids = [...(request.repositoryIds ?? [])].sort((a, b) => a - b);
  const permissions = Object.entries(request.permissions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, level]) => `${name}:${level}`);
  return `${request.installationId}|${ids.join(',') || '*'}|${permissions.join(',')}`;
}

/**
 * Installation access tokens, scoped as narrowly as GitHub allows: one
 * repository and only the permissions of the operation (e.g. `contents:
 * read` for fetching, `contents: write` for pushing, `pull_requests: write`
 * for creating a PR). They are valid for an hour; this cache reuses a token
 * for at most ten minutes, and never writes one anywhere: not into git
 * config, remote URLs, the database or logs.
 */
export class InstallationTokens {
  private readonly cache = new Map<
    string,
    { minted: number; token: Promise<InstallationToken> }
  >();

  constructor(
    private readonly credentials: GitHubAppCredentials,
    private readonly http: GitHubHttp,
    private readonly now: () => number = Date.now,
  ) {}

  async get(request: InstallationTokenRequest): Promise<InstallationToken> {
    if (request.fresh) {
      return this.mint(request);
    }
    const key = cacheKey(request);
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.minted < TOKEN_REUSE_MS) {
      try {
        const token = await cached.token;
        if (token.expiresAt.getTime() - this.now() > MIN_REMAINING_MS) {
          return token;
        }
      } catch {
        // minting failed before; try again
      }
    }
    const entry = { minted: this.now(), token: this.mint(request) };
    this.cache.set(key, entry);
    entry.token.catch(() => {
      if (this.cache.get(key) === entry) {
        this.cache.delete(key);
      }
    });
    return entry.token;
  }

  /** Revokes a token early (`DELETE /installation/token`). */
  async revoke(token: string): Promise<void> {
    for (const [key, entry] of this.cache) {
      const cached = await entry.token.catch(() => null);
      if (cached?.token === token) {
        this.cache.delete(key);
      }
    }
    await this.http.request({
      method: 'DELETE',
      path: '/installation/token',
      token,
    });
  }

  /** Forgets cached tokens of an installation (e.g. it was removed). */
  invalidate(installationId: number): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${installationId}|`)) {
        this.cache.delete(key);
      }
    }
  }

  private async mint(
    request: InstallationTokenRequest,
  ): Promise<InstallationToken> {
    const response = await this.http.request<{
      token: string;
      expires_at: string;
      permissions?: GitHubPermissionSet;
    }>({
      method: 'POST',
      path: `/app/installations/${request.installationId}/access_tokens`,
      token: this.credentials.jwt(),
      body: {
        ...(request.repositoryIds
          ? { repository_ids: request.repositoryIds }
          : {}),
        permissions: request.permissions,
      },
    });
    return {
      token: response.data.token,
      expiresAt: new Date(response.data.expires_at),
      installationId: request.installationId,
      repositoryIds: request.repositoryIds ?? null,
      permissions: response.data.permissions ?? request.permissions,
    };
  }
}
