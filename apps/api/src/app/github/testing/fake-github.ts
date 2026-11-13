import { createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { GitHubAppCredentials } from '../github-app-credentials';
import { GitHubHttp, type FetchLike } from '../github-http';
import { GitHubService } from '../github.service';
import {
  InstallationTokens,
  type GitHubPermissionSet,
} from '../installation-tokens';

/** One RSA key for all tests of a process (generating one takes a while). */
let sharedKey: { privateKey: KeyObject; publicKey: KeyObject } | undefined;
export function testKeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  sharedKey ??= generateKeyPairSync('rsa', { modulusLength: 2048 });
  return sharedKey;
}

export const FAKE_APP_ID = '4242';

export interface FakeRepository {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
}

export interface FakeInstallation {
  id: number;
  account: string;
  type: 'User' | 'Organization';
  repositories: FakeRepository[];
}

export interface MintedToken {
  token: string;
  installationId: number;
  repositoryIds: number[] | null;
  permissions: GitHubPermissionSet;
  revoked: boolean;
}

export interface FakePullRequest {
  number: number;
  repositoryId: number;
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
  state: 'open' | 'closed';
  merged: boolean;
  createdAt: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** `jwt`, a minted token, or `none`. */
  auth: 'jwt' | MintedToken | 'none';
  body: unknown;
}

const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * A GitHub API in memory, for tests without network. It checks what the
 * real API checks that matters here: JWT signature and issuer on app
 * endpoints, and on installation endpoints that the token belongs to the
 * installation, covers the repository and has the permission.
 */
export class FakeGitHub {
  readonly keys = testKeyPair();
  readonly installations: FakeInstallation[] = [];
  readonly tokens: MintedToken[] = [];
  readonly pulls: FakePullRequest[] = [];
  readonly requests: RecordedRequest[] = [];
  /** Page size of `/installation/repositories` (to test pagination). */
  pageSize = 100;
  /** Whether a head branch exists on GitHub (for pull requests). */
  headExists: (repository: FakeRepository, head: string) => boolean = () =>
    true;
  /** Answers a request before the fake does, e.g. with an error. */
  intercept: ((request: RecordedRequest) => Response | undefined) | null = null;
  private nextId = 1000;

  readonly fetch: FetchLike = async (url, init) => this.handle(url, init);
  readonly credentials = GitHubAppCredentials.fromKey(
    FAKE_APP_ID,
    this.keys.privateKey,
  );
  readonly http = new GitHubHttp(this.fetch, { sleep: async () => undefined });
  readonly installationTokens = new InstallationTokens(
    this.credentials,
    this.http,
  );
  readonly service = new GitHubService(
    this.credentials,
    this.http,
    this.installationTokens,
  );

  addInstallation(
    account: string,
    type: 'User' | 'Organization' = 'User',
  ): FakeInstallation {
    const installation = {
      id: this.nextId++,
      account,
      type,
      repositories: [],
    };
    this.installations.push(installation);
    return installation;
  }

  addRepository(
    installation: FakeInstallation,
    name: string,
    options: Partial<FakeRepository> = {},
  ): FakeRepository {
    const repository: FakeRepository = {
      id: this.nextId++,
      owner: installation.account,
      name,
      private: true,
      defaultBranch: 'main',
      ...options,
    };
    installation.repositories.push(repository);
    return repository;
  }

  /** Requests to a path (without query), e.g. to count token mints. */
  requestsTo(method: string, pattern: RegExp): RecordedRequest[] {
    return this.requests.filter(
      (request) => request.method === method && pattern.test(request.path),
    );
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const parsed = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const authorization = new Headers(init.headers).get('authorization') ?? '';
    const credential = authorization.replace(/^Bearer /, '');
    const request: RecordedRequest = {
      method,
      path: parsed.pathname,
      query: parsed.searchParams,
      auth: this.authOf(credential),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    };
    this.requests.push(request);
    const intercepted = this.intercept?.(request);
    if (intercepted) {
      return intercepted;
    }
    return this.route(request);
  }

  private authOf(credential: string): RecordedRequest['auth'] {
    const token = this.tokens.find((entry) => entry.token === credential);
    if (token) {
      return token;
    }
    const parts = credential.split('.');
    if (parts.length === 3) {
      const valid = createVerify('RSA-SHA256')
        .update(`${parts[0]}.${parts[1]}`)
        .verify(this.keys.publicKey, Buffer.from(parts[2], 'base64url'));
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString(),
      ) as { iss?: string; exp?: number; iat?: number };
      const now = Date.now() / 1000;
      if (
        valid &&
        payload.iss === FAKE_APP_ID &&
        (payload.exp ?? 0) > now &&
        (payload.exp ?? 0) - (payload.iat ?? 0) <= 600
      ) {
        return 'jwt';
      }
    }
    return 'none';
  }

  private repositoryByName(owner: string, name: string) {
    for (const installation of this.installations) {
      const repository = installation.repositories.find(
        (entry) =>
          entry.owner.toLowerCase() === owner.toLowerCase() &&
          entry.name.toLowerCase() === name.toLowerCase(),
      );
      if (repository) {
        return { installation, repository };
      }
    }
    return null;
  }

  private rawRepository(repository: FakeRepository) {
    return {
      id: repository.id,
      name: repository.name,
      full_name: `${repository.owner}/${repository.name}`,
      owner: { login: repository.owner },
      private: repository.private,
      archived: false,
      default_branch: repository.defaultBranch,
      description: null,
      pushed_at: '2026-01-01T00:00:00Z',
      html_url: `https://github.com/${repository.owner}/${repository.name}`,
    };
  }

  private rawPull(pull: FakePullRequest) {
    const repository = this.installations
      .flatMap((installation) => installation.repositories)
      .find((entry) => entry.id === pull.repositoryId) as FakeRepository;
    return {
      number: pull.number,
      html_url: `https://github.com/${repository.owner}/${repository.name}/pull/${pull.number}`,
      title: pull.title,
      state: pull.state,
      draft: pull.draft,
      merged_at: pull.merged ? '2026-01-02T00:00:00Z' : null,
      closed_at: pull.state === 'closed' ? '2026-01-02T00:00:00Z' : null,
      created_at: pull.createdAt,
      head: { ref: pull.head },
      base: { ref: pull.base },
    };
  }

  /** Token check for repository endpoints. */
  private allows(
    auth: RecordedRequest['auth'],
    repository: FakeRepository,
    permission: keyof GitHubPermissionSet,
    level: 'read' | 'write',
  ): boolean {
    if (auth === 'jwt' || auth === 'none' || auth.revoked) {
      return false;
    }
    const installation = this.installations.find(
      (entry) => entry.id === auth.installationId,
    );
    const granted = auth.permissions[permission];
    return (
      !!installation?.repositories.includes(repository) &&
      (auth.repositoryIds === null ||
        auth.repositoryIds.includes(repository.id)) &&
      (granted === 'write' || granted === level)
    );
  }

  private route(request: RecordedRequest): Response {
    const { method, path, auth } = request;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const denied = () =>
      json(403, { message: 'Resource not accessible by integration' });
    let match: RegExpExecArray | null;

    if (method === 'GET' && path === '/app') {
      return auth === 'jwt'
        ? json(200, {
            name: 'Test App',
            slug: 'test-app',
            html_url: 'https://github.com/apps/test-app',
          })
        : json(401, { message: 'Bad credentials' });
    }
    if (method === 'GET' && path === '/app/installations') {
      if (auth !== 'jwt') {
        return json(401, { message: 'Bad credentials' });
      }
      return json(
        200,
        this.installations.map((installation) => ({
          id: installation.id,
          account: { login: installation.account, type: installation.type },
          repository_selection: 'selected',
          html_url: `https://github.com/settings/installations/${installation.id}`,
        })),
      );
    }
    if (
      method === 'POST' &&
      (match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path))
    ) {
      if (auth !== 'jwt') {
        return json(401, { message: 'Bad credentials' });
      }
      const installation = this.installations.find(
        (entry) => entry.id === Number(match?.[1]),
      );
      if (!installation) {
        return json(404, { message: 'Not Found' });
      }
      const ids = body['repository_ids'] as number[] | undefined;
      if (
        ids &&
        ids.some(
          (id) => !installation.repositories.some((entry) => entry.id === id),
        )
      ) {
        return json(422, {
          message:
            'There is at least one repository that does not exist or is not accessible to the parent installation.',
        });
      }
      const token: MintedToken = {
        token: `ghs_fake${this.tokens.length + 1}`,
        installationId: installation.id,
        repositoryIds: ids ?? null,
        permissions: body['permissions'] as GitHubPermissionSet,
        revoked: false,
      };
      this.tokens.push(token);
      return json(201, {
        token: token.token,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: token.permissions,
      });
    }
    if (method === 'DELETE' && path === '/installation/token') {
      if (auth === 'jwt' || auth === 'none') {
        return json(401, { message: 'Bad credentials' });
      }
      auth.revoked = true;
      return json(204, null);
    }
    if (method === 'GET' && path === '/installation/repositories') {
      if (auth === 'jwt' || auth === 'none' || auth.revoked) {
        return json(401, { message: 'Bad credentials' });
      }
      const installation = this.installations.find(
        (entry) => entry.id === auth.installationId,
      ) as FakeInstallation;
      const all = installation.repositories.filter(
        (repository) =>
          auth.repositoryIds === null ||
          auth.repositoryIds.includes(repository.id),
      );
      const perPage = Math.min(
        Number(request.query.get('per_page') ?? 30),
        this.pageSize,
      );
      const page = Number(request.query.get('page') ?? 1);
      const items = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        headers['link'] =
          `<https://api.github.com/installation/repositories?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      }
      return json(
        200,
        {
          total_count: all.length,
          repositories: items.map((repository) =>
            this.rawRepository(repository),
          ),
        },
        headers,
      );
    }
    if (
      method === 'GET' &&
      (match = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path))
    ) {
      const found = this.repositoryByName(
        decodeURIComponent(match[1]),
        decodeURIComponent(match[2]),
      );
      return auth !== 'jwt'
        ? json(401, { message: 'Bad credentials' })
        : found
          ? json(200, { id: found.installation.id })
          : json(404, { message: 'Not Found' });
    }
    if ((match = /^\/repos\/([^/]+)\/([^/]+)\/pulls(?:\/(\d+))?$/.exec(path))) {
      const found = this.repositoryByName(
        decodeURIComponent(match[1]),
        decodeURIComponent(match[2]),
      );
      if (!found) {
        return json(404, { message: 'Not Found' });
      }
      const { repository } = found;
      const write = method === 'POST';
      if (
        !this.allows(
          auth,
          repository,
          'pull_requests',
          write ? 'write' : 'read',
        ) ||
        (write && !this.allows(auth, repository, 'contents', 'read'))
      ) {
        // Creating needs to read the refs too.
        return write
          ? json(422, {
              message: 'Validation Failed',
              errors: [{ message: 'not all refs are readable' }],
            })
          : denied();
      }
      if (method === 'GET' && match[3]) {
        const pull = this.pulls.find(
          (entry) =>
            entry.repositoryId === repository.id &&
            entry.number === Number(match?.[3]),
        );
        return pull
          ? json(200, this.rawPull(pull))
          : json(404, { message: 'Not Found' });
      }
      if (method === 'GET') {
        const head = request.query.get('head')?.split(':')[1];
        return json(
          200,
          this.pulls
            .filter(
              (entry) =>
                entry.repositoryId === repository.id &&
                (!head || entry.head === head) &&
                entry.state === 'open',
            )
            .map((entry) => this.rawPull(entry)),
        );
      }
      const head = String(body['head']);
      if (!this.headExists(repository, head)) {
        return json(422, {
          message: 'Validation Failed',
          errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
        });
      }
      if (
        this.pulls.some(
          (entry) =>
            entry.repositoryId === repository.id &&
            entry.head === head &&
            entry.state === 'open',
        )
      ) {
        return json(422, {
          message: 'Validation Failed',
          errors: [
            {
              resource: 'PullRequest',
              code: 'custom',
              message: `A pull request already exists for ${repository.owner}:${head}.`,
            },
          ],
        });
      }
      const pull: FakePullRequest = {
        number: this.pulls.length + 1,
        repositoryId: repository.id,
        title: String(body['title']),
        body: String(body['body'] ?? ''),
        head,
        base: String(body['base']),
        draft: Boolean(body['draft']),
        state: 'open',
        merged: false,
        createdAt: new Date().toISOString(),
      };
      this.pulls.push(pull);
      return json(201, this.rawPull(pull));
    }
    if (
      method === 'POST' &&
      ((match = /^\/orgs\/([^/]+)\/repos$/.exec(path)) ||
        path === '/user/repos')
    ) {
      if (auth === 'jwt' || auth === 'none' || auth.revoked) {
        return json(401, { message: 'Bad credentials' });
      }
      const installation = this.installations.find(
        (entry) => entry.id === auth.installationId,
      ) as FakeInstallation;
      const organization = match !== null;
      if (
        auth.permissions.administration !== 'write' ||
        (organization &&
          (installation.type !== 'Organization' ||
            installation.account.toLowerCase() !==
              decodeURIComponent(match?.[1] ?? '').toLowerCase())) ||
        // What GitHub answered for this app's installation token.
        !organization
      ) {
        return denied();
      }
      const repository = this.addRepository(
        installation,
        String(body['name']),
        {
          private: body['private'] !== false,
        },
      );
      return json(201, this.rawRepository(repository));
    }
    return json(404, { message: `Fake GitHub: no route ${method} ${path}` });
  }
}
