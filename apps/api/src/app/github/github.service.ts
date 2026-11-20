import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type {
  GitHubInstallationDto,
  GitHubRepositoryDto,
  GitHubStatusDto,
} from '@claude-remote-manager/shared-types';
import { GitHubAppCredentials } from './github-app-credentials';
import { GitHubApiError, GitHubNotConfiguredError } from './github-errors';
import { GitHubHttp } from './github-http';
import {
  InstallationTokens,
  type GitHubPermissionSet,
  type InstallationToken,
} from './installation-tokens';

/** Why the app cannot create repositories in personal accounts. */
export const PERSONAL_ACCOUNT_CREATION =
  'The GitHub App cannot create repositories in a personal account (GitHub refuses its installation token there). Create an empty repository on GitHub and attach it to the project instead.';

/** Host of clone URLs of GitHub repositories. */
export const GITHUB_HOST = 'github.com';

/** How long installations and repository lists are cached. */
export const LIST_CACHE_MS = 60_000;
const APP_CACHE_MS = 10 * 60_000;

/** `https://github.com/<owner>/<name>.git`. */
export function githubCloneUrl(owner: string, name: string): string {
  return `https://${GITHUB_HOST}/${owner}/${name}.git`;
}

/**
 * `owner/name` of an https clone URL on github.com, or `null` for other
 * URLs (ssh, other hosts, local paths).
 */
export function githubFullName(url: string | null): string | null {
  if (!url) {
    return null;
  }
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
    url,
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

export interface GitHubInstallation {
  id: number;
  account: string;
  accountType: string;
  repositorySelection: string;
  settingsUrl: string | null;
}

/** A repository as listed by an installation. */
export type GitHubRepository = Omit<
  GitHubRepositoryDto,
  'registeredRepositoryId'
>;

export interface RepositoryListing {
  repositories: GitHubRepository[];
  /** Repository counts per installation (`null`: listing failed). */
  counts: Map<number, number | null>;
  errors: Map<number, string>;
  fetchedAt: Date;
}

/** Ways GitHub merges a pull request. */
export type MergeMethod = 'rebase' | 'squash' | 'merge';

/**
 * The order automerge tries (the owner's choice): rebase, else squash, a
 * merge commit only when neither is possible.
 */
export const MERGE_METHODS: readonly MergeMethod[] = [
  'rebase',
  'squash',
  'merge',
];

export interface PullRequestInfo {
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  headBranch: string;
  /** Head commit; `null` if GitHub did not say. */
  headSha: string | null;
  baseBranch: string;
  createdAt: Date;
  closedAt: Date | null;
  mergedAt: Date | null;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface CreatedRepository {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string | null;
  htmlUrl: string;
}

interface RawRepository {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  archived?: boolean;
  default_branch?: string | null;
  description?: string | null;
  pushed_at?: string | null;
  html_url: string;
}

interface RawPullRequest {
  number: number;
  html_url: string;
  title: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  created_at: string;
  head: { ref: string; sha?: string };
  base: { ref: string };
}

interface RawInstallation {
  id: number;
  account: { login: string; type: string } | null;
  repository_selection: string;
  html_url?: string;
}

/** A review thread of a pull request (GraphQL). */
export interface ReviewThreadInfo {
  /** GraphQL node ID. */
  id: string;
  resolved: boolean;
  /**
   * REST ID of its first (root) comment: GitHub takes replies only to
   * that one ("Replies to replies are not supported").
   */
  rootCommentId: number;
  /**
   * When the last comment not written by the app itself (GraphQL
   * `viewerDidAuthor`, the viewer being the app's installation) appeared:
   * per comment the latest of `createdAt`, `publishedAt` (a comment of a
   * review is created when written, published when the review is
   * submitted) and `lastEditedAt`. `null` (fail closed) when there is
   * none, GitHub did not list every comment, or any comment lacks what
   * this needs.
   */
  lastOtherCommentAt: Date | null;
}

/** The latest push to a branch, as GitHub's repository activity lists it. */
export interface BranchPush {
  /** Commit the branch points to after the push. */
  after: string;
  /** When GitHub received it. */
  at: Date;
}

/** Pages of 100 review threads searched at most for a comment. */
export const MAX_REVIEW_THREAD_PAGES = 5;

const REVIEW_THREAD_LOOKUP_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 100) {
            totalCount
            nodes { databaseId createdAt publishedAt lastEditedAt viewerDidAuthor }
          }
        }
      }
    }
  }
}`;

const RESOLVE_REVIEW_THREAD_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message?: string }[];
}

type RawThreadLookup = GraphQLResponse<{
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: ({
          id?: string;
          isResolved?: boolean;
          comments?: {
            totalCount?: number;
            nodes?: ({
              databaseId?: number | null;
              createdAt?: string | null;
              publishedAt?: string | null;
              lastEditedAt?: string | null;
              viewerDidAuthor?: boolean;
            } | null)[];
          };
        } | null)[];
      };
    } | null;
  } | null;
}>;

interface RawActivity {
  activity_type?: string;
  after?: string;
  ref?: string;
  timestamp?: string;
}

type RawResolveThread = GraphQLResponse<{
  resolveReviewThread?: {
    thread?: { id?: string; isResolved?: boolean } | null;
  } | null;
}>;

/**
 * See {@link ReviewThreadInfo.lastOtherCommentAt}: anything incomplete or
 * malformed gives `null`, never a skipped comment.
 */
function lastOtherCommentAt(comments: {
  totalCount?: number;
  nodes?: ({
    createdAt?: string | null;
    publishedAt?: string | null;
    lastEditedAt?: string | null;
    viewerDidAuthor?: boolean;
  } | null)[];
}): Date | null {
  const nodes = comments.nodes ?? [];
  if (comments.totalCount !== nodes.length) {
    return null;
  }
  let latest: number | null = null;
  for (const comment of nodes) {
    if (!comment || typeof comment.viewerDidAuthor !== 'boolean') {
      return null;
    }
    if (comment.viewerDidAuthor) {
      continue;
    }
    const created = Date.parse(comment.createdAt ?? '');
    const published = Date.parse(comment.publishedAt ?? '');
    const edited =
      comment.lastEditedAt == null ? null : Date.parse(comment.lastEditedAt);
    if (
      !Number.isFinite(created) ||
      !Number.isFinite(published) ||
      (edited !== null && !Number.isFinite(edited))
    ) {
      return null;
    }
    const time = Math.max(created, published, edited ?? created);
    latest = latest === null ? time : Math.max(latest, time);
  }
  return latest === null ? null : new Date(latest);
}

/**
 * The data of a GraphQL answer; GitHub reports errors (also missing
 * permissions) with status 200 in `errors`.
 */
function graphqlData<T>(response: GraphQLResponse<T>, what: string): T {
  const message = response?.errors?.find((error) => error?.message)?.message;
  if (response?.errors?.length || !response?.data) {
    throw new Error(`GitHub did not ${what}${message ? `: ${message}` : ''}`);
  }
  return response.data;
}

/** `owner/name` with both parts URL-encoded. */
function repoPath(fullName: string): string {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPullRequest(raw: RawPullRequest): PullRequestInfo {
  return {
    number: raw.number,
    url: raw.html_url,
    title: raw.title,
    state: raw.merged_at ? 'merged' : raw.state,
    draft: raw.draft ?? false,
    headBranch: raw.head.ref,
    headSha:
      typeof raw.head.sha === 'string' && /^[0-9a-f]{40}$/.test(raw.head.sha)
        ? raw.head.sha
        : null,
    baseBranch: raw.base.ref,
    createdAt: new Date(raw.created_at),
    closedAt: raw.closed_at ? new Date(raw.closed_at) : null,
    mergedAt: raw.merged_at ? new Date(raw.merged_at) : null,
  };
}

function toRepository(
  raw: RawRepository,
  installationId: number,
): GitHubRepository {
  return {
    id: raw.id,
    installationId,
    owner: raw.owner.login,
    name: raw.name,
    fullName: raw.full_name,
    private: raw.private,
    archived: raw.archived ?? false,
    defaultBranch: raw.default_branch ?? null,
    description: raw.description ?? null,
    pushedAt: raw.pushed_at ?? null,
    htmlUrl: raw.html_url,
  };
}

/**
 * The GitHub App: its installations, the repositories they can access, and
 * the few API operations of the app (pull requests, repository creation).
 * Every call authenticates with the app JWT or with an installation token
 * narrowed to the repository and permissions of the call.
 */
@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);
  private app: {
    at: number;
    value: Promise<{ name: string; slug: string; url: string }>;
  } | null = null;
  private installationCache: {
    at: number;
    value: Promise<GitHubInstallation[]>;
  } | null = null;
  private listingCache: {
    at: number;
    value: Promise<RepositoryListing>;
  } | null = null;

  constructor(
    readonly credentials: GitHubAppCredentials,
    private readonly http: GitHubHttp,
    readonly tokens: InstallationTokens,
    private readonly now: () => number = Date.now,
  ) {}

  get configured(): boolean {
    return this.credentials.configured;
  }

  /** Throws a clear error when the app is not configured. */
  requireConfigured(): void {
    if (!this.configured) {
      throw new GitHubNotConfiguredError(this.credentials.problem ?? undefined);
    }
  }

  async status(): Promise<GitHubStatusDto> {
    const base: GitHubStatusDto = {
      configured: this.configured,
      problem: this.configured ? null : this.credentials.problem,
      appId: this.credentials.appId,
      appName: null,
      appSlug: null,
      appUrl: null,
      installUrl: null,
      installations: [],
      error: null,
    };
    if (!this.configured) {
      return base;
    }
    try {
      const app = await this.appInfo();
      const installations = await this.installations();
      const listing = await this.listing();
      return {
        ...base,
        appName: app.name,
        appSlug: app.slug,
        appUrl: app.url,
        installUrl: `https://${GITHUB_HOST}/apps/${app.slug}/installations/new`,
        installations: installations.map(
          (installation): GitHubInstallationDto => ({
            ...installation,
            repositoryCount: listing.counts.get(installation.id) ?? null,
            error: listing.errors.get(installation.id) ?? null,
          }),
        ),
      };
    } catch (error) {
      return { ...base, error: errorText(error) };
    }
  }

  /** Installations of the app (cached for a minute). */
  installations(refresh = false): Promise<GitHubInstallation[]> {
    this.requireConfigured();
    if (
      refresh ||
      !this.installationCache ||
      this.now() - this.installationCache.at > LIST_CACHE_MS
    ) {
      const value = this.http
        .paginate<RawInstallation[], RawInstallation>(
          { path: '/app/installations', token: this.credentials.jwt() },
          (page) => page,
        )
        .then((raw) =>
          raw
            .filter((installation) => installation.account)
            .map((installation) => ({
              id: installation.id,
              account: installation.account?.login ?? '',
              accountType: installation.account?.type ?? 'User',
              repositorySelection: installation.repository_selection,
              settingsUrl: installation.html_url ?? null,
            })),
        );
      this.installationCache = { at: this.now(), value };
      value.catch(() => {
        if (this.installationCache?.value === value) {
          this.installationCache = null;
        }
      });
    }
    return this.installationCache.value;
  }

  /**
   * All repositories the installations can access, across the user's
   * account and organizations (cached for a minute). An installation whose
   * repositories cannot be listed is reported in `errors`; the others are
   * still listed.
   */
  listing(refresh = false): Promise<RepositoryListing> {
    this.requireConfigured();
    if (
      refresh ||
      !this.listingCache ||
      this.now() - this.listingCache.at > LIST_CACHE_MS
    ) {
      const value = this.fetchListing(refresh);
      this.listingCache = { at: this.now(), value };
      value.catch(() => {
        if (this.listingCache?.value === value) {
          this.listingCache = null;
        }
      });
    }
    return this.listingCache.value;
  }

  /** A repository the installations can access, by GitHub ID. */
  async findRepository(id: number): Promise<GitHubRepository | null> {
    const cached = (await this.listing()).repositories.find(
      (repository) => repository.id === id,
    );
    if (cached) {
      return cached;
    }
    return (
      (await this.listing(true)).repositories.find(
        (repository) => repository.id === id,
      ) ?? null
    );
  }

  /** Installation that covers `owner/name` now (it may have changed). */
  async installationFor(owner: string, name: string): Promise<number | null> {
    this.requireConfigured();
    try {
      const response = await this.http.request<{ id: number }>({
        path: `/repos/${repoPath(`${owner}/${name}`)}/installation`,
        token: this.credentials.jwt(),
      });
      return response.data.id;
    } catch (error) {
      if (error instanceof GitHubApiError && error.githubStatus === 404) {
        return null;
      }
      throw error;
    }
  }

  /** A token for one repository with the given permissions. */
  repositoryToken(
    installationId: number,
    repositoryId: number,
    permissions: GitHubPermissionSet,
    fresh = false,
  ): Promise<InstallationToken> {
    this.requireConfigured();
    return this.tokens.get({
      installationId,
      repositoryIds: [repositoryId],
      permissions,
      fresh,
    });
  }

  /**
   * Creates a pull request. If one exists already for the head branch,
   * returns that one (`existing: true`).
   */
  async createPullRequest(
    installationId: number,
    repositoryId: number,
    fullName: string,
    input: CreatePullRequestInput,
  ): Promise<PullRequestInfo & { existing: boolean }> {
    // GitHub also has to read the head and base refs for the token
    // ("not all refs are readable" without contents: read).
    const { token } = await this.repositoryToken(installationId, repositoryId, {
      pull_requests: 'write',
      contents: 'read',
    });
    try {
      const response = await this.http.request<RawPullRequest>({
        method: 'POST',
        path: `/repos/${repoPath(fullName)}/pulls`,
        token,
        body: {
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
          draft: input.draft ?? false,
          maintainer_can_modify: true,
        },
      });
      return { ...toPullRequest(response.data), existing: false };
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        error.githubStatus === 422 &&
        error.details.some((detail) => /already exists/i.test(detail))
      ) {
        const owner = fullName.split('/')[0];
        const open = await this.http.request<RawPullRequest[]>({
          path: `/repos/${repoPath(fullName)}/pulls`,
          token,
          query: { head: `${owner}:${input.head}`, state: 'open' },
        });
        if (open.data[0]) {
          return { ...toPullRequest(open.data[0]), existing: true };
        }
      }
      if (
        error instanceof GitHubApiError &&
        error.githubStatus === 422 &&
        error.details.some((detail) => /^head\b/i.test(detail))
      ) {
        throw new GitHubApiError(
          422,
          `The branch ${input.head} does not exist on GitHub; push it first`,
        );
      }
      throw error;
    }
  }

  async getPullRequest(
    installationId: number,
    repositoryId: number,
    fullName: string,
    number: number,
  ): Promise<PullRequestInfo> {
    const { token } = await this.repositoryToken(installationId, repositoryId, {
      pull_requests: 'read',
    });
    const response = await this.http.request<RawPullRequest>({
      path: `/repos/${repoPath(fullName)}/pulls/${number}`,
      token,
    });
    return toPullRequest(response.data);
  }

  /**
   * Pull requests (open, closed and merged) whose head is `branch` of the
   * repository itself (not of a fork), newest first, at most 100.
   */
  async pullRequestsFrom(
    installationId: number,
    repositoryId: number,
    fullName: string,
    branch: string,
  ): Promise<PullRequestInfo[]> {
    const { token } = await this.repositoryToken(installationId, repositoryId, {
      pull_requests: 'read',
    });
    const owner = fullName.split('/')[0];
    const response = await this.http.request<RawPullRequest[]>({
      path: `/repos/${repoPath(fullName)}/pulls`,
      token,
      query: { head: `${owner}:${branch}`, state: 'all', per_page: 100 },
    });
    return response.data.map(toPullRequest);
  }

  /**
   * Open pull requests whose base is `branch` (deleting the branch would
   * close them), at most 100.
   */
  async openPullRequestsInto(
    installationId: number,
    repositoryId: number,
    fullName: string,
    branch: string,
  ): Promise<PullRequestInfo[]> {
    const { token } = await this.repositoryToken(installationId, repositoryId, {
      pull_requests: 'read',
    });
    const response = await this.http.request<RawPullRequest[]>({
      path: `/repos/${repoPath(fullName)}/pulls`,
      token,
      query: { base: branch, state: 'open', per_page: 100 },
    });
    return response.data.map(toPullRequest);
  }

  /**
   * The review thread of a pull request that contains the review comment
   * `commentId` (its REST ID, GraphQL's `databaseId`; one of its first 100
   * comments), through GraphQL (REST knows no threads). `null` when no
   * thread of this pull request has it. Uses a token
   * with `pull_requests: write`, the one {@link resolveReviewThread} and
   * {@link replyToReviewComment} need as well.
   */
  async findReviewThread(
    installationId: number,
    repositoryId: number,
    fullName: string,
    number: number,
    commentId: number,
  ): Promise<ReviewThreadInfo | null> {
    const token = await this.reviewToken(installationId, repositoryId);
    const [owner, name] = fullName.split('/');
    let after: string | null = null;
    for (let page = 0; page < MAX_REVIEW_THREAD_PAGES; page++) {
      const response: { data: RawThreadLookup } =
        await this.http.request<RawThreadLookup>({
          method: 'POST',
          path: '/graphql',
          token,
          body: {
            query: REVIEW_THREAD_LOOKUP_QUERY,
            variables: { owner, name, number, after },
          },
        });
      const connection = graphqlData(response.data, 'list the review threads')
        .repository?.pullRequest?.reviewThreads;
      if (!connection?.nodes) {
        throw new Error(
          `GitHub did not list the review threads of ${fullName}#${number}`,
        );
      }
      for (const node of connection.nodes) {
        if (
          node?.id &&
          node.comments?.nodes?.some(
            (comment) => comment?.databaseId === commentId,
          )
        ) {
          const root = node.comments.nodes[0]?.databaseId;
          if (typeof root !== 'number') {
            throw new Error(
              `GitHub did not name the first comment of the review thread of ${commentId}`,
            );
          }
          return {
            id: node.id,
            resolved: node.isResolved === true,
            rootCommentId: root,
            lastOtherCommentAt: lastOtherCommentAt(node.comments),
          };
        }
      }
      if (!connection.pageInfo?.hasNextPage) {
        return null;
      }
      after = connection.pageInfo.endCursor ?? null;
    }
    throw new Error(
      `${fullName}#${number} has more than ${MAX_REVIEW_THREAD_PAGES * 100} review threads`,
    );
  }

  /**
   * The latest push to a branch, from GitHub's repository activity (its
   * own record of when it received pushes, which nobody can backdate);
   * `null` when the latest activity of the branch is no push (or none).
   */
  async latestBranchPush(
    installationId: number,
    repositoryId: number,
    fullName: string,
    branch: string,
  ): Promise<BranchPush | null> {
    const { token } = await this.repositoryToken(installationId, repositoryId, {
      // GitHub lists the activity endpoint under Contents (read).
      contents: 'read',
    });
    const response = await this.http.request<RawActivity[]>({
      path: `/repos/${repoPath(fullName)}/activity`,
      token,
      query: { ref: `refs/heads/${branch}`, direction: 'desc', per_page: 1 },
    });
    const latest = response.data[0];
    const at = Date.parse(latest?.timestamp ?? '');
    if (
      !latest ||
      (latest.activity_type !== 'push' &&
        latest.activity_type !== 'force_push') ||
      typeof latest.after !== 'string' ||
      !Number.isFinite(at)
    ) {
      return null;
    }
    return { after: latest.after, at: new Date(at) };
  }

  /** Resolves a review thread (its GraphQL node ID). */
  async resolveReviewThread(
    installationId: number,
    repositoryId: number,
    threadId: string,
  ): Promise<void> {
    const token = await this.reviewToken(installationId, repositoryId);
    const response = await this.http.request<RawResolveThread>({
      method: 'POST',
      path: '/graphql',
      token,
      body: {
        query: RESOLVE_REVIEW_THREAD_MUTATION,
        variables: { threadId },
      },
    });
    const thread = graphqlData(response.data, 'resolve the review thread')
      .resolveReviewThread?.thread;
    if (thread?.isResolved !== true) {
      throw new Error('GitHub did not resolve the review thread');
    }
  }

  /**
   * Replies to a review comment of a pull request: the reply goes into
   * the comment's thread. Returns the reply's URL.
   */
  async replyToReviewComment(
    installationId: number,
    repositoryId: number,
    fullName: string,
    number: number,
    commentId: number,
    body: string,
  ): Promise<{ id: number; url: string }> {
    const token = await this.reviewToken(installationId, repositoryId);
    const response = await this.http.request<{ id: number; html_url: string }>({
      method: 'POST',
      path: `/repos/${repoPath(fullName)}/pulls/${number}/comments/${commentId}/replies`,
      token,
      body: { body },
    });
    return { id: response.data.id, url: response.data.html_url };
  }

  /**
   * Merges a pull request, exactly at `sha` (GitHub refuses when the head
   * moved), trying the methods in order: a method the repository does not
   * allow, or a rebase GitHub cannot do, goes on to the next one. Returns
   * the method that merged; other refusals throw ({@link GitHubApiError}).
   */
  async mergePullRequest(
    installationId: number,
    repositoryId: number,
    fullName: string,
    number: number,
    sha: string,
    methods: readonly MergeMethod[] = MERGE_METHODS,
  ): Promise<MergeMethod> {
    const { token } = await this.repositoryToken(installationId, repositoryId, {
      pull_requests: 'write',
      contents: 'write',
    });
    let refusal: unknown = null;
    for (const method of methods) {
      try {
        await this.http.request<{ merged?: boolean }>({
          method: 'PUT',
          path: `/repos/${repoPath(fullName)}/pulls/${number}/merge`,
          token,
          body: { sha, merge_method: method },
        });
        return method;
      } catch (error) {
        if (
          error instanceof GitHubApiError &&
          error.githubStatus === 405 &&
          /not allowed|can(?:no|')t be rebased/i.test(error.message)
        ) {
          refusal = error;
          continue;
        }
        throw error;
      }
    }
    throw refusal ?? new Error('No merge method to try');
  }

  /**
   * Creates an empty repository in an organization the app is installed
   * on: `POST /orgs/{org}/repos` with an installation token (needs the
   * Administration permission). Personal accounts are refused before
   * asking GitHub: GitHub's documentation lists `POST /user/repos` for
   * installation tokens, but tried with this app it answered 403 ("Rate
   * Limit Exceeded", with `x-accepted-github-permissions: administration=
   * write; repository_creation=write`), so creating a repository there
   * needs a user access token. Attach an existing empty repository instead.
   */
  async createRepository(input: {
    installation: GitHubInstallation;
    name: string;
    private: boolean;
    description: string | null;
  }): Promise<CreatedRepository> {
    const { installation } = input;
    if (installation.accountType !== 'Organization') {
      throw new BadRequestException(PERSONAL_ACCOUNT_CREATION);
    }
    const { token } = await this.tokens.get({
      installationId: installation.id,
      permissions: { administration: 'write', metadata: 'read' },
      fresh: true,
    });
    try {
      const response = await this.http.request<RawRepository>({
        method: 'POST',
        path: `/orgs/${encodeURIComponent(installation.account)}/repos`,
        token,
        body: {
          name: input.name,
          private: input.private,
          ...(input.description ? { description: input.description } : {}),
          auto_init: false,
        },
      });
      this.listingCache = null;
      return {
        id: response.data.id,
        owner: response.data.owner.login,
        name: response.data.name,
        defaultBranch: response.data.default_branch ?? null,
        htmlUrl: response.data.html_url,
      };
    } finally {
      this.tokens.revoke(token).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------

  /** Token for replying on and resolving review threads of one repository. */
  private async reviewToken(
    installationId: number,
    repositoryId: number,
  ): Promise<string> {
    return (
      await this.repositoryToken(installationId, repositoryId, {
        pull_requests: 'write',
      })
    ).token;
  }

  private appInfo(): Promise<{ name: string; slug: string; url: string }> {
    if (!this.app || this.now() - this.app.at > APP_CACHE_MS) {
      const value = this.http
        .request<{ name: string; slug: string; html_url: string }>({
          path: '/app',
          token: this.credentials.jwt(),
        })
        .then(({ data }) => ({
          name: data.name,
          slug: data.slug,
          url: data.html_url,
        }));
      this.app = { at: this.now(), value };
      value.catch(() => {
        if (this.app?.value === value) {
          this.app = null;
        }
      });
    }
    return this.app.value;
  }

  private async fetchListing(refresh: boolean): Promise<RepositoryListing> {
    const installations = await this.installations(refresh);
    const counts = new Map<number, number | null>();
    const errors = new Map<number, string>();
    const lists = await Promise.all(
      installations.map(async (installation) => {
        try {
          // Listing only needs metadata; the token covers the whole
          // installation but cannot read or write code.
          const { token } = await this.tokens.get({
            installationId: installation.id,
            permissions: { metadata: 'read' },
          });
          const repositories = await this.http.paginate<
            { repositories: RawRepository[] },
            RawRepository
          >(
            { path: '/installation/repositories', token },
            (page) => page.repositories,
          );
          counts.set(installation.id, repositories.length);
          return repositories.map((raw) => toRepository(raw, installation.id));
        } catch (error) {
          counts.set(installation.id, null);
          errors.set(
            installation.id,
            `${installation.account}: ${errorText(error)}`,
          );
          this.logger.warn(
            `Listing the repositories of installation ${installation.id} failed: ${errorText(error)}`,
          );
          return [];
        }
      }),
    );
    const seen = new Set<number>();
    const repositories = lists
      .flat()
      .filter((repository) => {
        if (seen.has(repository.id)) {
          return false;
        }
        seen.add(repository.id);
        return true;
      })
      .sort((a, b) =>
        a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' }),
      );
    return { repositories, counts, errors, fetchedAt: new Date(this.now()) };
  }
}
