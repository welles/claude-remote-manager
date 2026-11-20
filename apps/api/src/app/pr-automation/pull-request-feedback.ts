import { GitHubApiError } from '../github/github-errors';
import type { GitHubHttp } from '../github/github-http';
import type { GitHubService } from '../github/github.service';
import type { GitHubPermissionSet } from '../github/installation-tokens';
import { TtlCache } from '../github/ttl-cache';

/**
 * What the PR automation reads from GitHub about a pull request: the
 * check runs and commit statuses of its head commit, its reviews and
 * review comments, the permission of their authors, and the end of a
 * failed GitHub Actions job's log. Everything with one installation token
 * per repository, limited to reading.
 *
 * All text in the results (check names and output, log lines, comments) was
 * written by other people and goes to Claude only as untrusted context.
 */

/** A repository registered from GitHub. */
export interface FeedbackRepository {
  installationId: number;
  githubRepositoryId: number;
  /** `owner/name`. */
  fullName: string;
}

/** A check run or commit status of a commit. */
export interface CheckResult {
  kind: 'check_run' | 'status';
  /** Check run ID (for Actions also the job ID); `null` for statuses. */
  id: number | null;
  name: string;
  /** `queued`, `in_progress`, `completed` (statuses: `completed` or `pending`). */
  status: string;
  /** Check runs: `success`, `failure`, ...; statuses: their state. */
  conclusion: string | null;
  url: string | null;
  /** App that created a check run, e.g. `github-actions`. */
  app: string | null;
  /** Output title and summary of a check run, or a status's description. */
  title: string | null;
  summary: string | null;
}

export interface ReviewFeedback {
  /** `comment`: a comment in the pull request's conversation. */
  kind: 'review' | 'review_comment' | 'comment';
  id: number;
  author: string | null;
  /** `User`, `Bot`, ... */
  authorType: string | null;
  body: string;
  createdAt: string;
  /** Reviews: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, ... */
  state: string | null;
  /** Reviews: the commit that was reviewed. */
  commitId: string | null;
  /** Review comments: file and line. */
  path: string | null;
  line: number | null;
  diffHunk: string | null;
}

/** An unresolved review thread of a pull request, with its first comment. */
export interface ReviewThread {
  author: string | null;
  /** `User`, `Bot`, ... (from GraphQL's `__typename`). */
  authorType: string | null;
  body: string;
  createdAt: string;
  path: string | null;
  line: number | null;
  /** The code it refers to changed since. */
  outdated: boolean;
  /**
   * REST ID of its first comment (for `reply_to_review_thread`); `null`
   * if GitHub did not say.
   */
  commentId: number | null;
}

/** Pages of 100 review threads read at most. */
export const MAX_THREAD_PAGES = 5;

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 1) {
            nodes { databaseId body createdAt author { __typename login } }
          }
        }
      }
    }
  }
}`;

interface RawThreadPage {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: ({
            isResolved?: boolean;
            isOutdated?: boolean;
            path?: string | null;
            line?: number | null;
            originalLine?: number | null;
            comments?: {
              nodes?: ({
                databaseId?: number | null;
                body?: string | null;
                createdAt?: string;
                author?: { __typename?: string; login?: string } | null;
              } | null)[];
            };
          } | null)[];
        };
      } | null;
    } | null;
  };
  errors?: { message?: string }[];
}

/** Conclusions of check runs (and states of statuses) that are failures. */
export const FAILED_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'startup_failure',
  'error',
]);

/** Permissions that count as write access to the repository. */
export const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

/** How long an author's permission is reused. */
export const PERMISSION_CACHE_MS = 10 * 60_000;

/** Log bytes kept from the end of a job's log, and read at most. */
export const LOG_TAIL_BYTES = 256 * 1024;
export const LOG_MAX_READ_BYTES = 32 * 1024 * 1024;

const TOKEN_PERMISSIONS: GitHubPermissionSet = {
  metadata: 'read',
  checks: 'read',
  statuses: 'read',
  pull_requests: 'read',
  actions: 'read',
  // Conversation comments of pull requests are issue comments.
  issues: 'read',
};

interface RawCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  details_url?: string | null;
  app?: { slug?: string } | null;
  output?: { title?: string | null; summary?: string | null } | null;
}

interface RawStatus {
  context: string;
  state: string;
  description?: string | null;
  target_url?: string | null;
}

interface RawUser {
  login: string;
  type?: string;
}

interface RawReview {
  id: number;
  user: RawUser | null;
  body?: string | null;
  state?: string;
  submitted_at?: string | null;
  commit_id?: string | null;
}

interface RawIssueComment {
  id: number;
  user: RawUser | null;
  body?: string | null;
  created_at: string;
}

interface RawReviewComment {
  id: number;
  user: RawUser | null;
  body?: string | null;
  created_at: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  diff_hunk?: string | null;
}

function repoPath(fullName: string): string {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

export class PullRequestFeedback {
  private readonly permissions = new TtlCache<string>(PERMISSION_CACHE_MS);

  constructor(
    private readonly github: GitHubService,
    private readonly http: GitHubHttp,
  ) {}

  /** Check runs and commit statuses of a commit. */
  async checks(
    repository: FeedbackRepository,
    sha: string,
  ): Promise<CheckResult[]> {
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error('Not a commit SHA');
    }
    const token = await this.token(repository);
    const base = `/repos/${repoPath(repository.fullName)}/commits/${sha}`;
    const runs = await this.http.paginate<
      { check_runs: RawCheckRun[] },
      RawCheckRun
    >(
      { path: `${base}/check-runs`, token, query: { filter: 'latest' } },
      (page) => page.check_runs,
      5,
    );
    const combined = await this.http.request<{ statuses?: RawStatus[] }>({
      path: `${base}/status`,
      token,
      query: { per_page: 100 },
    });
    return [
      ...runs.map(
        (run): CheckResult => ({
          kind: 'check_run',
          id: run.id,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          url: run.html_url ?? run.details_url ?? null,
          app: run.app?.slug ?? null,
          title: run.output?.title ?? null,
          summary: run.output?.summary ?? null,
        }),
      ),
      ...(combined.data.statuses ?? []).map(
        (status): CheckResult => ({
          kind: 'status',
          id: null,
          name: status.context,
          status: status.state === 'pending' ? 'pending' : 'completed',
          conclusion: status.state,
          url: status.target_url ?? null,
          app: null,
          title: status.description ?? null,
          summary: null,
        }),
      ),
    ];
  }

  /**
   * Reviews, review comments and conversation comments of a pull request
   * (the latest ones; conversation comments updated since `since`).
   */
  async reviews(
    repository: FeedbackRepository,
    number: number,
    since: Date = new Date(0),
  ): Promise<ReviewFeedback[]> {
    const token = await this.token(repository);
    const base = `/repos/${repoPath(repository.fullName)}/pulls/${number}`;
    const reviews = await this.http.paginate<RawReview[], RawReview>(
      { path: `${base}/reviews`, token },
      (page) => page,
      3,
    );
    // Newest first, so the latest 100 are in the first page.
    const comments = await this.http.request<RawReviewComment[]>({
      path: `${base}/comments`,
      token,
      query: { sort: 'created', direction: 'desc', per_page: 100 },
    });
    const conversation = await this.http.paginate<
      RawIssueComment[],
      RawIssueComment
    >(
      {
        path: `/repos/${repoPath(repository.fullName)}/issues/${number}/comments`,
        token,
        query: { since: since.toISOString() },
      },
      (page) => page,
      3,
    );
    return [
      ...conversation.map(
        (comment): ReviewFeedback => ({
          kind: 'comment',
          id: comment.id,
          author: comment.user?.login ?? null,
          authorType: comment.user?.type ?? null,
          body: comment.body ?? '',
          createdAt: comment.created_at,
          state: null,
          commitId: null,
          path: null,
          line: null,
          diffHunk: null,
        }),
      ),
      ...reviews
        .filter((review) => review.submitted_at)
        .map(
          (review): ReviewFeedback => ({
            kind: 'review',
            id: review.id,
            author: review.user?.login ?? null,
            authorType: review.user?.type ?? null,
            body: review.body ?? '',
            createdAt: review.submitted_at as string,
            state: review.state ?? null,
            commitId: review.commit_id ?? null,
            path: null,
            line: null,
            diffHunk: null,
          }),
        ),
      ...comments.data.map(
        (comment): ReviewFeedback => ({
          kind: 'review_comment',
          id: comment.id,
          author: comment.user?.login ?? null,
          authorType: comment.user?.type ?? null,
          body: comment.body ?? '',
          createdAt: comment.created_at,
          state: null,
          commitId: null,
          path: comment.path ?? null,
          line: comment.line ?? comment.original_line ?? null,
          diffHunk: comment.diff_hunk ?? null,
        }),
      ),
    ];
  }

  /**
   * The review threads of a pull request that are not resolved (GraphQL;
   * REST has no resolution state). Throws when GitHub's answer is
   * incomplete, so that nothing is taken for resolved by mistake.
   */
  async unresolvedThreads(
    repository: FeedbackRepository,
    number: number,
  ): Promise<ReviewThread[]> {
    const token = await this.token(repository);
    const [owner, name] = repository.fullName.split('/');
    const threads: ReviewThread[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_THREAD_PAGES; page++) {
      const response: { data: RawThreadPage } =
        await this.http.request<RawThreadPage>({
          method: 'POST',
          path: '/graphql',
          token,
          body: {
            query: REVIEW_THREADS_QUERY,
            variables: { owner, name, number, after },
          },
        });
      const { data, errors } = response.data ?? {};
      const connection = data?.repository?.pullRequest?.reviewThreads;
      if ((errors && errors.length > 0) || !connection?.nodes) {
        throw new Error(
          `GitHub did not list the review threads${errors?.[0]?.message ? `: ${errors[0].message}` : ''}`,
        );
      }
      for (const node of connection.nodes) {
        if (!node || node.isResolved !== false) {
          continue;
        }
        const first = node.comments?.nodes?.[0] ?? null;
        const login = first?.author?.login ?? null;
        threads.push({
          // GraphQL names apps without the `[bot]` REST (and
          // PR_TRUSTED_BOTS) use.
          author:
            login &&
            first?.author?.__typename === 'Bot' &&
            !login.endsWith('[bot]')
              ? `${login}[bot]`
              : login,
          authorType: first?.author?.__typename ?? null,
          body: first?.body ?? '',
          createdAt: first?.createdAt ?? '',
          path: node.path ?? null,
          line: node.line ?? node.originalLine ?? null,
          outdated: node.isOutdated === true,
          commentId:
            typeof first?.databaseId === 'number' ? first.databaseId : null,
        });
      }
      if (!connection.pageInfo?.hasNextPage) {
        return threads;
      }
      after = connection.pageInfo.endCursor ?? null;
    }
    throw new Error(
      `The pull request has more than ${MAX_THREAD_PAGES * 100} review threads`,
    );
  }

  /**
   * Whether a GitHub user has write access (admin, maintain or write) to
   * the repository. Cached for {@link PERMISSION_CACHE_MS}.
   */
  async canWrite(
    repository: FeedbackRepository,
    login: string,
  ): Promise<boolean> {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(login)) {
      return false;
    }
    const key = `${repository.githubRepositoryId}|${login.toLowerCase()}`;
    const permission = await this.permissions.get(key, () =>
      this.permission(repository, login),
    );
    return WRITE_PERMISSIONS.has(permission);
  }

  private async permission(
    repository: FeedbackRepository,
    login: string,
  ): Promise<string> {
    const token = await this.token(repository);
    try {
      const response = await this.http.request<{
        permission?: string;
        role_name?: string;
      }>({
        path: `/repos/${repoPath(repository.fullName)}/collaborators/${encodeURIComponent(login)}/permission`,
        token,
      });
      // `role_name` tells maintain apart (`permission` says write for it).
      const role = response.data.role_name;
      return role && WRITE_PERMISSIONS.has(role)
        ? role
        : (response.data.permission ?? 'none');
    } catch (error) {
      if (error instanceof GitHubApiError && error.githubStatus === 404) {
        return 'none';
      }
      throw error;
    }
  }

  /**
   * The end of a GitHub Actions job's log (the job ID is its check run ID),
   * at most {@link LOG_TAIL_BYTES}; `null` if GitHub has none (expired,
   * no access).
   */
  async jobLogTail(
    repository: FeedbackRepository,
    jobId: number,
  ): Promise<string | null> {
    const token = await this.token(repository);
    try {
      const response = await this.http.request<string>({
        path: `/repos/${repoPath(repository.fullName)}/actions/jobs/${jobId}/logs`,
        token,
        accept: 'application/vnd.github+json',
        tail: { bytes: LOG_TAIL_BYTES, maxRead: LOG_MAX_READ_BYTES },
      });
      return response.data;
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        [403, 404, 410].includes(error.githubStatus)
      ) {
        return null;
      }
      throw error;
    }
  }

  private async token(repository: FeedbackRepository): Promise<string> {
    return (
      await this.github.repositoryToken(
        repository.installationId,
        repository.githubRepositoryId,
        TOKEN_PERMISSIONS,
      )
    ).token;
  }
}
