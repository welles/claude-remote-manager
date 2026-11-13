import { Injectable } from '@nestjs/common';
import {
  isRepositoryFullName,
  referenceUrl,
  type GitHubReferenceKind,
  type GitHubReferenceState,
} from '@claude-remote-manager/shared-types';
import { GitHubApiError } from './github-errors';
import { GitHubHttp } from './github-http';
import type { GitHubPermissionSet } from './installation-tokens';
import { GitHubService, type GitHubRepository } from './github.service';
import { TtlCache } from './ttl-cache';

/** How long issue data from GitHub is reused. */
export const ISSUE_CACHE_MS = 60_000;
/** An unknown repository name refreshes the repository list at most this often. */
const LISTING_REFRESH_MS = 15_000;
/** Comments fetched per kind at most (the latest ones). */
export const MAX_FETCHED_COMMENTS = 100;
/** Files listed when a diff is too large for GitHub to render. */
const MAX_DIFF_FILES = 300;

/** An issue or pull request with what the preview and context need. */
export interface IssueItem {
  repository: string;
  number: number;
  kind: GitHubReferenceKind;
  title: string;
  state: GitHubReferenceState;
  draft: boolean;
  url: string;
  author: string | null;
  body: string;
  labels: string[];
  /** Issue comments (conversation tab). */
  comments: number;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  pull: {
    headBranch: string;
    baseBranch: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    reviewComments: number;
  } | null;
}

/** A comment, review or review comment, for the context. */
export interface IssueComment {
  kind: 'comment' | 'review' | 'review_comment';
  author: string | null;
  createdAt: string;
  body: string;
  /** Review comments: file and line. */
  path?: string;
  line?: number | null;
  /** Reviews: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, ... */
  reviewState?: string;
}

export interface IssueComments {
  /** All comments GitHub counts (may be more than fetched). */
  total: number;
  /** The latest ones, oldest first. */
  items: IssueComment[];
}

export interface PullDiff {
  text: string;
  /** `files`: GitHub refused the diff (too large); per-file patches. */
  source: 'diff' | 'files';
  /** Files left out of a per-file listing. */
  omittedFiles: number;
}

interface RawUser {
  login: string;
}

interface RawIssue {
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  draft?: boolean;
  user: RawUser | null;
  labels?: (string | { name?: string })[];
  comments?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  pull_request?: { merged_at?: string | null };
}

interface RawPull {
  draft?: boolean;
  merged_at?: string | null;
  head: { ref: string };
  base: { ref: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  review_comments?: number;
}

interface RawComment {
  user: RawUser | null;
  body?: string | null;
  created_at: string;
}

interface RawReviewComment extends RawComment {
  path?: string;
  line?: number | null;
  original_line?: number | null;
}

interface RawReview {
  user: RawUser | null;
  body?: string | null;
  state?: string;
  submitted_at?: string | null;
}

interface RawFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

/** `owner/name` with both parts URL-encoded. */
function repoPath(fullName: string): string {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

function toItem(repository: string, raw: RawIssue): IssueItem {
  const kind: GitHubReferenceKind = raw.pull_request ? 'pull_request' : 'issue';
  return {
    repository,
    number: raw.number,
    kind,
    title: raw.title,
    state: raw.pull_request?.merged_at ? 'merged' : raw.state,
    draft: raw.draft ?? false,
    url: referenceUrl(repository, raw.number, kind),
    author: raw.user?.login ?? null,
    body: raw.body ?? '',
    labels: (raw.labels ?? [])
      .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
      .filter(Boolean),
    comments: raw.comments ?? 0,
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
    closedAt: raw.closed_at ?? null,
    pull: null,
  };
}

/** No repository of the installations has this name. */
export class RepositoryNotAccessibleError extends Error {
  constructor(readonly repository: string) {
    super(
      `The GitHub App cannot access ${repository} (not installed there, or the repository does not exist)`,
    );
    this.name = 'RepositoryNotAccessibleError';
  }
}

/**
 * Issues and pull requests of repositories the GitHub App can access, read
 * with installation tokens limited to one repository and to reading issues
 * and pull requests. Results are cached for {@link ISSUE_CACHE_MS}.
 * Repository names are checked against GitHub's naming rules and looked up
 * in the installations' repository list before anything is requested, so a
 * name in a message never makes the API call anything else.
 */
@Injectable()
export class GitHubIssues {
  private readonly recentCache = new TtlCache<IssueItem[]>(ISSUE_CACHE_MS);
  private readonly searchCache = new TtlCache<IssueItem[]>(ISSUE_CACHE_MS);
  private readonly itemCache = new TtlCache<IssueItem>(ISSUE_CACHE_MS);
  private readonly commentCache = new TtlCache<IssueComments>(ISSUE_CACHE_MS);
  private readonly diffCache = new TtlCache<PullDiff>(ISSUE_CACHE_MS, 50);
  private listingRefreshedAt = 0;

  constructor(
    private readonly github: GitHubService,
    private readonly http: GitHubHttp,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The accessible repository with this name (any case); throws
   * {@link RepositoryNotAccessibleError} for others.
   */
  async repository(fullName: string): Promise<GitHubRepository> {
    if (!isRepositoryFullName(fullName)) {
      throw new RepositoryNotAccessibleError(fullName);
    }
    this.github.requireConfigured();
    const find = (repositories: GitHubRepository[]) =>
      repositories.find(
        (repository) =>
          repository.fullName.toLowerCase() === fullName.toLowerCase(),
      );
    const listing = await this.github.listing();
    let found = find(listing.repositories);
    if (
      !found &&
      this.now() -
        Math.max(this.listingRefreshedAt, listing.fetchedAt.getTime()) >
        LISTING_REFRESH_MS
    ) {
      this.listingRefreshedAt = this.now();
      found = find((await this.github.listing(true)).repositories);
    }
    if (!found) {
      throw new RepositoryNotAccessibleError(fullName);
    }
    return found;
  }

  /** The most recently updated issues and pull requests (up to 100). */
  recent(repository: GitHubRepository): Promise<IssueItem[]> {
    return this.recentCache.get(repository.fullName.toLowerCase(), async () => {
      const { data } = await this.http.request<RawIssue[]>({
        path: `/repos/${repoPath(repository.fullName)}/issues`,
        token: await this.token(repository),
        query: {
          state: 'all',
          sort: 'updated',
          direction: 'desc',
          per_page: 100,
        },
      });
      return data.map((raw) => toItem(repository.fullName, raw));
    });
  }

  /** Issues and pull requests whose title contains the words. */
  search(repository: GitHubRepository, words: string): Promise<IssueItem[]> {
    const key = `${repository.fullName.toLowerCase()} ${words.toLowerCase()}`;
    return this.searchCache.get(key, async () => {
      // Quotes would end GitHub's own phrase syntax; the words are only
      // ever part of the `q` parameter of the search endpoint.
      const terms = words.replace(/["\\]/g, ' ').trim();
      const { data } = await this.http.request<{ items: RawIssue[] }>({
        path: '/search/issues',
        token: await this.token(repository),
        query: {
          q: `repo:${repository.fullName} in:title ${terms}`,
          sort: 'updated',
          order: 'desc',
          per_page: 30,
        },
      });
      return data.items.map((raw) => toItem(repository.fullName, raw));
    });
  }

  /** One issue or pull request (pull requests with branch and size). */
  item(repository: GitHubRepository, number: number): Promise<IssueItem> {
    const key = `${repository.fullName.toLowerCase()}#${number}`;
    return this.itemCache.get(key, async () => {
      const token = await this.token(repository);
      const { data } = await this.http.request<RawIssue>({
        path: `/repos/${repoPath(repository.fullName)}/issues/${number}`,
        token,
      });
      const item = toItem(repository.fullName, data);
      if (item.kind === 'pull_request') {
        const pull = (
          await this.http.request<RawPull>({
            path: `/repos/${repoPath(repository.fullName)}/pulls/${number}`,
            token,
          })
        ).data;
        item.draft = pull.draft ?? false;
        item.state = pull.merged_at ? 'merged' : item.state;
        item.pull = {
          headBranch: pull.head.ref,
          baseBranch: pull.base.ref,
          additions: pull.additions ?? 0,
          deletions: pull.deletions ?? 0,
          changedFiles: pull.changed_files ?? 0,
          reviewComments: pull.review_comments ?? 0,
        };
      }
      return item;
    });
  }

  /**
   * The latest comments of an issue, and of a pull request also its
   * reviews and review comments, oldest first. At most
   * {@link MAX_FETCHED_COMMENTS} of each kind are fetched.
   */
  comments(
    repository: GitHubRepository,
    item: IssueItem,
  ): Promise<IssueComments> {
    const key = `${repository.fullName.toLowerCase()}#${item.number}@${item.updatedAt}`;
    return this.commentCache.get(key, async () => {
      const token = await this.token(repository);
      const base = `/repos/${repoPath(repository.fullName)}`;
      const [comments, reviewComments, reviews] = await Promise.all([
        this.latest<RawComment>(
          `${base}/issues/${item.number}/comments`,
          token,
          item.comments,
        ),
        item.pull
          ? this.latest<RawReviewComment>(
              `${base}/pulls/${item.number}/comments`,
              token,
              item.pull.reviewComments,
            )
          : Promise.resolve([]),
        item.pull
          ? this.http
              .request<RawReview[]>({
                path: `${base}/pulls/${item.number}/reviews`,
                token,
                query: { per_page: 100 },
              })
              .then(({ data }) => data)
          : Promise.resolve([] as RawReview[]),
      ]);
      const withBody = reviews.filter(
        (review) =>
          (review.body ?? '').trim() ||
          review.state === 'APPROVED' ||
          review.state === 'CHANGES_REQUESTED',
      );
      const items: IssueComment[] = [
        ...comments.map(
          (raw): IssueComment => ({
            kind: 'comment',
            author: raw.user?.login ?? null,
            createdAt: raw.created_at,
            body: raw.body ?? '',
          }),
        ),
        ...reviewComments.map(
          (raw): IssueComment => ({
            kind: 'review_comment',
            author: raw.user?.login ?? null,
            createdAt: raw.created_at,
            body: raw.body ?? '',
            path: raw.path,
            line: raw.line ?? raw.original_line ?? null,
          }),
        ),
        ...withBody.map(
          (raw): IssueComment => ({
            kind: 'review',
            author: raw.user?.login ?? null,
            createdAt: raw.submitted_at ?? '',
            body: raw.body ?? '',
            reviewState: raw.state,
          }),
        ),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return {
        total:
          item.comments + (item.pull?.reviewComments ?? 0) + withBody.length,
        items,
      };
    });
  }

  /**
   * The diff of a pull request; per-file patches when GitHub refuses to
   * render the whole diff (too many lines or files).
   */
  diff(repository: GitHubRepository, item: IssueItem): Promise<PullDiff> {
    const key = `${repository.fullName.toLowerCase()}#${item.number}@${item.updatedAt}`;
    return this.diffCache.get(key, async () => {
      // GitHub renders a diff only for a token that can read the code.
      const token = await this.token(repository, { contents: 'read' });
      const path = `/repos/${repoPath(repository.fullName)}/pulls/${item.number}`;
      try {
        const { data } = await this.http.request<string>({
          path,
          token,
          accept: 'application/vnd.github.diff',
        });
        return { text: data, source: 'diff', omittedFiles: 0 };
      } catch (error) {
        if (
          !(error instanceof GitHubApiError) ||
          ![406, 422].includes(error.githubStatus)
        ) {
          throw error;
        }
      }
      const files = await this.http.paginate<RawFile[], RawFile>(
        { path: `${path}/files`, token },
        (page) => page,
        Math.ceil(MAX_DIFF_FILES / 100),
      );
      const text = files
        .map((file) => {
          const name = file.previous_filename
            ? `${file.previous_filename} → ${file.filename}`
            : file.filename;
          const header = `diff of ${name} (${file.status}, +${file.additions} -${file.deletions})`;
          return file.patch
            ? `${header}\n${file.patch}`
            : `${header}\n(no patch: binary or too large)`;
        })
        .join('\n');
      return {
        text,
        source: 'files',
        omittedFiles: Math.max(
          0,
          (item.pull?.changedFiles ?? 0) - files.length,
        ),
      };
    });
  }

  private async token(
    repository: GitHubRepository,
    extra: GitHubPermissionSet = {},
  ): Promise<string> {
    return (
      await this.github.repositoryToken(
        repository.installationId,
        repository.id,
        { issues: 'read', pull_requests: 'read', ...extra },
      )
    ).token;
  }

  /**
   * The latest `MAX_FETCHED_COMMENTS` items of a list GitHub returns
   * oldest first, with `count` items in total: the last page, and the one
   * before when the last page is short.
   */
  private async latest<T>(
    path: string,
    token: string,
    count: number,
  ): Promise<T[]> {
    if (count <= 0) {
      return [];
    }
    const perPage = 100;
    const lastPage = Math.max(1, Math.ceil(count / perPage));
    const pages = [lastPage];
    if (
      lastPage > 1 &&
      count % perPage !== 0 &&
      count % perPage < MAX_FETCHED_COMMENTS
    ) {
      pages.unshift(lastPage - 1);
    }
    const results = await Promise.all(
      pages.map((page) =>
        this.http
          .request<T[]>({ path, token, query: { per_page: perPage, page } })
          .then(({ data }) => data),
      ),
    );
    return results.flat().slice(-MAX_FETCHED_COMMENTS);
  }
}
