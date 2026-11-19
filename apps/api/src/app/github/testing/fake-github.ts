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
  /** Head commit (40 hex digits). */
  headSha: string;
}

/** An issue or pull request for references (`#12`). */
export interface FakeIssue {
  repositoryId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: string | null;
  labels: string[];
  updatedAt: string;
  comments: { author: string | null; body: string; createdAt: string }[];
  /** Set for pull requests. */
  pull: {
    merged: boolean;
    draft: boolean;
    head: string;
    base: string;
    /** `null`: GitHub refuses the diff as too large (406). */
    diff: string | null;
    files: {
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }[];
    reviewComments: {
      author: string | null;
      body: string;
      createdAt: string;
      path: string;
      line: number;
    }[];
    reviews: {
      author: string | null;
      body: string;
      state: string;
      submittedAt: string;
    }[];
  } | null;
}

/** A check run of a commit (PR automation). */
export interface FakeCheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  app: string;
  title?: string;
  summary?: string;
}

/** A review or review comment of a pull request created through the app. */
export interface FakeReviewItem {
  kind: 'review' | 'review_comment' | 'comment';
  id: number;
  author: string;
  authorType?: 'User' | 'Bot';
  body: string;
  createdAt: string;
  state?: string;
  /** Reviews: the commit reviewed. */
  commitId?: string;
  path?: string;
  line?: number;
  diffHunk?: string;
}

/** A review thread of a pull request (GraphQL `reviewThreads`). */
export interface FakeReviewThread {
  resolved: boolean;
  outdated?: boolean;
  author: string;
  authorType?: 'User' | 'Bot';
  body: string;
  path?: string;
  line?: number;
  createdAt?: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** `Accept` header. */
  accept: string | null;
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
  readonly issues: FakeIssue[] = [];
  readonly requests: RecordedRequest[] = [];
  /** Page size of `/installation/repositories` (to test pagination). */
  pageSize = 100;
  /** Whether a head branch exists on GitHub (for pull requests). */
  headExists: (repository: FakeRepository, head: string) => boolean = () =>
    true;
  /** Check runs and commit statuses per commit SHA. */
  readonly checkRuns = new Map<string, FakeCheckRun[]>();
  readonly statuses = new Map<
    string,
    { context: string; state: string; description?: string }[]
  >();
  /** Reviews and review comments per `<repository id>#<number>`. */
  readonly reviewItems = new Map<string, FakeReviewItem[]>();
  /** Permission per login (`admin`, `write`, `read`, ...); others 404. */
  readonly collaborators = new Map<string, string>();
  /** Logs of GitHub Actions jobs by job ID. */
  readonly jobLogs = new Map<number, string>();
  /** Review threads per `<repository id>#<number>`. */
  readonly reviewThreads = new Map<string, FakeReviewThread[]>();
  /** Merge methods the repositories allow. */
  allowedMergeMethods = new Set(['rebase', 'squash', 'merge']);
  /** Merges done: pull request number and method. */
  readonly merges: { number: number; method: string; sha: string }[] = [];
  /** Head commit GitHub reports for a new pull request's branch. */
  headSha: (repository: FakeRepository, head: string) => string = () =>
    'a'.repeat(40);
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

  /** Adds an issue (or, with `pull`, a pull request) to a repository. */
  addIssue(
    repository: FakeRepository,
    options: Partial<Omit<FakeIssue, 'pull'>> & {
      pull?: Partial<NonNullable<FakeIssue['pull']>> | boolean;
    } = {},
  ): FakeIssue {
    const { pull, ...rest } = options;
    const issue: FakeIssue = {
      repositoryId: repository.id,
      number:
        this.issues.filter((entry) => entry.repositoryId === repository.id)
          .length + 1,
      title: 'An issue',
      body: '',
      state: 'open',
      author: 'octocat',
      labels: [],
      updatedAt: new Date(
        Date.UTC(2026, 0, 1 + this.issues.length),
      ).toISOString(),
      comments: [],
      ...rest,
      pull: pull
        ? {
            merged: false,
            draft: false,
            head: 'feature',
            base: 'main',
            diff: 'diff --git a/a.txt b/a.txt\n+added\n',
            files: [],
            reviewComments: [],
            reviews: [],
            ...(typeof pull === 'object' ? pull : {}),
          }
        : null,
    };
    this.issues.push(issue);
    return issue;
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
      accept: new Headers(init.headers).get('accept'),
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
      head: { ref: pull.head, sha: pull.headSha },
      base: { ref: pull.base },
    };
  }

  private rawIssue(issue: FakeIssue) {
    const repository = this.repositoryById(issue.repositoryId);
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      draft: issue.pull?.draft ?? false,
      user: issue.author ? { login: issue.author } : null,
      labels: issue.labels.map((name) => ({ name })),
      comments: issue.comments.length,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: issue.updatedAt,
      closed_at: issue.state === 'closed' ? issue.updatedAt : null,
      html_url: `https://github.com/${repository.owner}/${repository.name}/${issue.pull ? 'pull' : 'issues'}/${issue.number}`,
      ...(issue.pull
        ? {
            pull_request: {
              merged_at: issue.pull.merged ? issue.updatedAt : null,
            },
          }
        : {}),
    };
  }

  private repositoryById(id: number): FakeRepository {
    return this.installations
      .flatMap((installation) => installation.repositories)
      .find((entry) => entry.id === id) as FakeRepository;
  }

  /** A page of a list, with a `Link` header to the next one. */
  private page<T>(request: RecordedRequest, all: T[]): Response {
    const perPage = Number(request.query.get('per_page') ?? 30);
    const page = Number(request.query.get('page') ?? 1);
    const headers: Record<string, string> = {};
    if (page * perPage < all.length) {
      headers['link'] =
        `<https://api.github.com${request.path}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
    }
    return json(200, all.slice((page - 1) * perPage, page * perPage), headers);
  }

  /** Issue routes: issues, comments, pull request details, diffs, search. */
  private issueRoute(request: RecordedRequest): Response | undefined {
    const { method, path, auth } = request;
    if (method !== 'GET') {
      return undefined;
    }
    if (path === '/search/issues') {
      const q = request.query.get('q') ?? '';
      const repo = /repo:(\S+)/.exec(q)?.[1] ?? '';
      const [owner, name] = repo.split('/');
      const found = this.repositoryByName(owner ?? '', name ?? '');
      if (!found || !this.allows(auth, found.repository, 'issues', 'read')) {
        return json(422, { message: 'Validation Failed' });
      }
      const words = q
        .replace(/repo:\S+/, '')
        .replace('in:title', '')
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const items = this.issues.filter(
        (issue) =>
          issue.repositoryId === found.repository.id &&
          words.every((word) => issue.title.toLowerCase().includes(word)),
      );
      return json(200, {
        total_count: items.length,
        items: items.map((issue) => this.rawIssue(issue)),
      });
    }
    const match =
      /^\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)(?:\/(\d+)(?:\/(comments|reviews|files))?)?$/.exec(
        path,
      );
    if (!match) {
      return undefined;
    }
    const found = this.repositoryByName(
      decodeURIComponent(match[1]),
      decodeURIComponent(match[2]),
    );
    if (!found) {
      return json(404, { message: 'Not Found' });
    }
    const { repository } = found;
    const [, , , collection, number, sub] = match;
    const issue = number
      ? this.issues.find(
          (entry) =>
            entry.repositoryId === repository.id &&
            entry.number === Number(number),
        )
      : undefined;
    if (collection === 'pulls' && (!number || !issue)) {
      // Pull requests created through the app (see `pulls`).
      return undefined;
    }
    const permission = collection === 'issues' ? 'issues' : 'pull_requests';
    if (!this.allows(auth, repository, permission, 'read')) {
      return json(403, { message: 'Resource not accessible by integration' });
    }
    if (collection === 'issues' && !number) {
      return this.page(
        request,
        this.issues
          .filter((entry) => entry.repositoryId === repository.id)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((entry) => this.rawIssue(entry)),
      );
    }
    if (!issue || (collection === 'pulls' && !issue.pull)) {
      return json(404, { message: 'Not Found' });
    }
    if (collection === 'issues') {
      return sub === 'comments'
        ? this.page(
            request,
            issue.comments.map((comment) => ({
              user: comment.author ? { login: comment.author } : null,
              body: comment.body,
              created_at: comment.createdAt,
            })),
          )
        : sub
          ? json(404, { message: 'Not Found' })
          : json(200, this.rawIssue(issue));
    }
    const pull = issue.pull as NonNullable<FakeIssue['pull']>;
    if (
      (request.accept === 'application/vnd.github.diff' || sub === 'files') &&
      !this.allows(auth, repository, 'contents', 'read')
    ) {
      // As GitHub: rendering changes needs read access to the code.
      return json(403, { message: 'Resource not accessible by integration' });
    }
    switch (sub) {
      case 'comments':
        return this.page(
          request,
          pull.reviewComments.map((comment) => ({
            user: comment.author ? { login: comment.author } : null,
            body: comment.body,
            created_at: comment.createdAt,
            path: comment.path,
            line: comment.line,
          })),
        );
      case 'reviews':
        return this.page(
          request,
          pull.reviews.map((review) => ({
            user: review.author ? { login: review.author } : null,
            body: review.body,
            state: review.state,
            submitted_at: review.submittedAt,
          })),
        );
      case 'files':
        return this.page(request, pull.files);
    }
    if (request.accept === 'application/vnd.github.diff') {
      return pull.diff === null
        ? json(406, {
            message:
              'Sorry, the diff exceeded the maximum number of lines (20000)',
          })
        : new Response(pull.diff, {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          });
    }
    return json(200, {
      number: issue.number,
      draft: pull.draft,
      merged_at: pull.merged ? issue.updatedAt : null,
      head: { ref: pull.head },
      base: { ref: pull.base },
      additions: 10,
      deletions: 2,
      changed_files: pull.files.length || 1,
      review_comments: pull.reviewComments.length,
    });
  }

  /** Routes the PR automation reads: checks, statuses, reviews, logs. */
  private automationRoute(request: RecordedRequest): Response | undefined {
    const { method, path, auth } = request;
    const match =
      /^\/repos\/([^/]+)\/([^/]+)\/(commits\/([0-9a-f]{40})\/(check-runs|status)|(pulls|issues)\/(\d+)\/(reviews|comments)|collaborators\/([^/]+)\/permission|actions\/jobs\/(\d+)\/logs)$/.exec(
        path,
      );
    if (method !== 'GET' || !match) {
      return undefined;
    }
    const found = this.repositoryByName(
      decodeURIComponent(match[1]),
      decodeURIComponent(match[2]),
    );
    if (!found) {
      return json(404, { message: 'Not Found' });
    }
    const { repository } = found;
    const denied = () =>
      json(403, { message: 'Resource not accessible by integration' });
    const [, , , , sha, commitPart, collection, number, pullPart, login, job] =
      match;
    if (sha) {
      if (commitPart === 'check-runs') {
        if (!this.allows(auth, repository, 'checks', 'read')) {
          return denied();
        }
        const runs = this.checkRuns.get(sha) ?? [];
        return json(200, {
          total_count: runs.length,
          check_runs: runs.map((run) => ({
            id: run.id,
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            html_url: `https://github.com/${repository.owner}/${repository.name}/runs/${run.id}`,
            app: { slug: run.app },
            output: { title: run.title ?? null, summary: run.summary ?? null },
          })),
        });
      }
      if (!this.allows(auth, repository, 'statuses', 'read')) {
        return denied();
      }
      return json(200, {
        state: 'failure',
        statuses: (this.statuses.get(sha) ?? []).map((status) => ({
          ...status,
          target_url: 'https://ci.example.com/build',
        })),
      });
    }
    if (number) {
      if (
        !this.pulls.some(
          (pull) =>
            pull.repositoryId === repository.id &&
            pull.number === Number(number),
        )
      ) {
        return undefined;
      }
      const user = (item: FakeReviewItem) => ({
        login: item.author,
        type: item.authorType ?? 'User',
      });
      if (collection === 'issues') {
        if (
          pullPart !== 'comments' ||
          !this.allows(auth, repository, 'issues', 'read')
        ) {
          return denied();
        }
        const since = request.query.get('since') ?? '';
        return this.page(
          request,
          (this.reviewItems.get(`${repository.id}#${number}`) ?? [])
            .filter(
              (item) => item.kind === 'comment' && item.createdAt >= since,
            )
            .map((item) => ({
              id: item.id,
              user: user(item),
              body: item.body,
              created_at: item.createdAt,
            })),
        );
      }
      if (!this.allows(auth, repository, 'pull_requests', 'read')) {
        return denied();
      }
      const items = (
        this.reviewItems.get(`${repository.id}#${number}`) ?? []
      ).filter((item) =>
        pullPart === 'reviews'
          ? item.kind === 'review'
          : item.kind === 'review_comment',
      );
      return pullPart === 'reviews'
        ? this.page(
            request,
            items.map((item) => ({
              id: item.id,
              user: user(item),
              body: item.body,
              state: item.state ?? 'COMMENTED',
              submitted_at: item.createdAt,
              commit_id: item.commitId ?? null,
            })),
          )
        : json(
            200,
            items
              .slice()
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((item) => ({
                id: item.id,
                user: user(item),
                body: item.body,
                created_at: item.createdAt,
                path: item.path,
                line: item.line ?? null,
                diff_hunk: item.diffHunk ?? null,
              })),
          );
    }
    if (login) {
      if (!this.allows(auth, repository, 'metadata', 'read')) {
        return denied();
      }
      const permission = this.collaborators.get(decodeURIComponent(login));
      return permission
        ? json(200, {
            permission: permission === 'maintain' ? 'write' : permission,
            role_name: permission,
          })
        : json(404, { message: 'Not Found' });
    }
    if (!this.allows(auth, repository, 'actions', 'read')) {
      return denied();
    }
    const log = this.jobLogs.get(Number(job));
    return log === undefined
      ? json(404, { message: 'Not Found' })
      : new Response(log, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
  }

  /** GraphQL: only the review threads of a pull request. */
  private graphqlRoute(request: RecordedRequest): Response | undefined {
    const { method, path, auth } = request;
    if (method !== 'POST' || path !== '/graphql') {
      return undefined;
    }
    const body = request.body as {
      query?: string;
      variables?: {
        owner?: string;
        name?: string;
        number?: number;
        after?: string | null;
      };
    };
    const variables = body.variables ?? {};
    const found = this.repositoryByName(
      variables.owner ?? '',
      variables.name ?? '',
    );
    if (!body.query?.includes('reviewThreads') || !found) {
      return json(200, { errors: [{ message: 'Fake GitHub: unknown query' }] });
    }
    if (!this.allows(auth, found.repository, 'pull_requests', 'read')) {
      return json(200, {
        data: { repository: null },
        errors: [{ message: 'Resource not accessible by integration' }],
      });
    }
    const all =
      this.reviewThreads.get(`${found.repository.id}#${variables.number}`) ??
      [];
    // Pages of two, to exercise the cursor.
    const start = Number(variables.after ?? 0);
    const page = all.slice(start, start + 2);
    return json(200, {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: {
                hasNextPage: start + 2 < all.length,
                endCursor: String(start + 2),
              },
              nodes: page.map((thread) => ({
                isResolved: thread.resolved,
                isOutdated: thread.outdated ?? false,
                path: thread.path ?? 'src/app.ts',
                line: thread.line ?? 1,
                originalLine: thread.line ?? 1,
                comments: {
                  nodes: [
                    {
                      body: thread.body,
                      createdAt: thread.createdAt ?? '2026-01-01T00:00:00Z',
                      author: {
                        __typename: thread.authorType ?? 'User',
                        // GraphQL names apps without `[bot]`.
                        login: thread.author.replace(/\[bot\]$/, ''),
                      },
                    },
                  ],
                },
              })),
            },
          },
        },
      },
    });
  }

  /** `PUT /repos/{owner}/{repo}/pulls/{number}/merge`. */
  private mergeRoute(request: RecordedRequest): Response | undefined {
    const { method, path, auth } = request;
    const match = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/.exec(path);
    if (method !== 'PUT' || !match) {
      return undefined;
    }
    const found = this.repositoryByName(
      decodeURIComponent(match[1]),
      decodeURIComponent(match[2]),
    );
    const pull = this.pulls.find(
      (entry) =>
        entry.repositoryId === found?.repository.id &&
        entry.number === Number(match[3]),
    );
    if (!found || !pull) {
      return json(404, { message: 'Not Found' });
    }
    if (
      !this.allows(auth, found.repository, 'pull_requests', 'write') ||
      !this.allows(auth, found.repository, 'contents', 'write')
    ) {
      return json(403, { message: 'Resource not accessible by integration' });
    }
    const body = (request.body ?? {}) as {
      sha?: string;
      merge_method?: string;
    };
    const merging = body.merge_method ?? 'merge';
    if (!this.allowedMergeMethods.has(merging)) {
      return json(405, {
        message: `${merging[0].toUpperCase()}${merging.slice(1)} merges are not allowed on this repository.`,
      });
    }
    if (pull.state !== 'open') {
      return json(405, { message: 'Pull Request is not mergeable' });
    }
    if (body.sha && body.sha !== pull.headSha) {
      return json(409, {
        message: 'Head branch was modified. Review and try the merge again.',
      });
    }
    pull.state = 'closed';
    pull.merged = true;
    this.merges.push({
      number: pull.number,
      method: merging,
      sha: pull.headSha,
    });
    return json(200, { sha: 'f'.repeat(40), merged: true, message: 'Merged' });
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

    const automationResponse =
      this.automationRoute(request) ??
      this.graphqlRoute(request) ??
      this.mergeRoute(request);
    if (automationResponse) {
      return automationResponse;
    }
    const issueResponse = this.issueRoute(request);
    if (issueResponse) {
      return issueResponse;
    }
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
        headSha: this.headSha(repository, head),
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
