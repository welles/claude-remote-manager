import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  isRepositoryFullName,
  MAX_REFERENCES_PER_MESSAGE,
  parseReferences,
  referenceKey,
  referenceUrl,
  type GitHubReferenceDetail,
  type GitHubReferenceSearchResponse,
  type GitHubReferenceSummary,
  type MessageReference,
  type MessageReferenceRequest,
} from '@claude-remote-manager/shared-types';
import type {
  UntrustedContext,
  UntrustedItem,
} from '../agent/untrusted-context';
import {
  GitHubApiError,
  GitHubNotConfiguredError,
  GitHubRateLimitError,
  GitHubUnavailableError,
} from '../github/github-errors';
import {
  GitHubIssues,
  RepositoryNotAccessibleError,
  type IssueComment,
  type IssueComments,
  type IssueItem,
  type PullDiff,
} from '../github/github-issues';
import type { GitHubRepository } from '../github/github.service';

/** Limits of what one message gives Claude. */
export const CONTEXT_LIMITS = {
  /** Characters of a description. */
  body: 8_000,
  /** Comments per reference (the latest). */
  comments: 50,
  /** Characters of one comment. */
  comment: 4_000,
  /** Characters of all comments of a reference. */
  commentsTotal: 40_000,
  /** Characters of a pull request's diff. */
  diff: 60_000,
  /** Characters of the whole context of a message. */
  total: 150_000,
} as const;

/** How long resolving the references of a message may take. */
export const RESOLVE_DEADLINE_MS = 20_000;

/** Suggestions returned at most. */
export const MAX_SUGGESTIONS = 20;
const MAX_QUERY_LENGTH = 100;
const MAX_SEARCHED_REPOSITORIES = 10;
/** Characters of a description in the preview. */
const PREVIEW_BODY = 3_000;

/** References of a message and the context they give Claude. */
export interface ResolvedReferences {
  references: MessageReference[];
  /** `null` when the message has no references. */
  context: UntrustedContext | null;
}

/** A reference written as `#12` or `owner/repo#12`, nothing else. */
const TOKEN = /^(?:[^\s#]+\/[^\s#]+)?#\d+$/;

function bool(value: unknown, name: string): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${name} must be a boolean`);
  }
  return value;
}

/**
 * Validates the `references` of a message: at most
 * {@link MAX_REFERENCES_PER_MESSAGE}, each a token in GitHub's syntax that
 * names a repository by GitHub's naming rules. Duplicates are merged.
 */
export function parseReferenceRequests(
  raw: unknown,
): MessageReferenceRequest[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new BadRequestException('references must be an array');
  }
  if (raw.length > MAX_REFERENCES_PER_MESSAGE) {
    throw new BadRequestException(
      `A message can reference at most ${MAX_REFERENCES_PER_MESSAGE} issues or pull requests`,
    );
  }
  const seen = new Map<string, MessageReferenceRequest>();
  raw.forEach((entry: unknown, index) => {
    const name = `references[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new BadRequestException(`${name} must be an object`);
    }
    const fields = entry as Record<string, unknown>;
    const { token, repository, number } = fields;
    if (typeof repository !== 'string' || !isRepositoryFullName(repository)) {
      throw new BadRequestException(
        `${name}.repository must be a GitHub repository name (owner/name)`,
      );
    }
    if (
      typeof number !== 'number' ||
      !Number.isInteger(number) ||
      number < 1 ||
      number > 999_999_999
    ) {
      throw new BadRequestException(`${name}.number must be an issue number`);
    }
    if (typeof token !== 'string' || token.length > 200 || !TOKEN.test(token)) {
      throw new BadRequestException(
        `${name}.token must be a reference such as #12 or owner/repo#12`,
      );
    }
    const parsed = parseReferences(token, repository);
    if (
      parsed.length !== 1 ||
      parsed[0].token !== token ||
      parsed[0].number !== number ||
      parsed[0].repository?.toLowerCase() !== repository.toLowerCase()
    ) {
      throw new BadRequestException(
        `${name}.token does not match its repository and number`,
      );
    }
    const request: MessageReferenceRequest = {
      token,
      repository,
      number,
      comments: bool(fields['comments'], `${name}.comments`),
      diff: bool(fields['diff'], `${name}.diff`),
    };
    const key = referenceKey(repository, number);
    const earlier = seen.get(key);
    seen.set(
      key,
      earlier
        ? {
            ...earlier,
            comments: earlier.comments || request.comments,
            diff: earlier.diff || request.diff,
          }
        : request,
    );
  });
  return [...seen.values()];
}

/** Why a reference could not be resolved, for the user and for Claude. */
export function referenceError(error: unknown): string {
  if (error instanceof RepositoryNotAccessibleError) {
    return error.message;
  }
  if (error instanceof GitHubApiError && error.githubStatus === 404) {
    return 'Not found on GitHub (or the GitHub App cannot see it)';
  }
  if (error instanceof GitHubRateLimitError) {
    return `GitHub's rate limit was reached; try again after ${error.resetAt.toISOString().slice(11, 16)} UTC`;
  }
  if (
    error instanceof GitHubUnavailableError ||
    error instanceof GitHubNotConfiguredError ||
    error instanceof GitHubApiError
  ) {
    return error.message;
  }
  if (error instanceof DeadlineError) {
    return error.message;
  }
  return 'GitHub could not be asked';
}

class DeadlineError extends Error {
  constructor(ms: number) {
    super(
      `GitHub did not answer within ${Math.max(1, Math.round(ms / 1000))} s`,
    );
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Text cut to `max` characters (at a line end when one is near). */
export function cut(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) {
    return { text, cut: false };
  }
  const head = text.slice(0, max);
  const lineEnd = head.lastIndexOf('\n');
  return {
    text: lineEnd > max * 0.8 ? head.slice(0, lineEnd) : head,
    cut: true,
  };
}

const number = (value: number) => value.toLocaleString('en-US');

function summary(item: IssueItem): GitHubReferenceSummary {
  return {
    repository: item.repository,
    number: item.number,
    kind: item.kind,
    title: item.title,
    state: item.state,
    draft: item.draft,
    url: item.url,
    author: item.author,
    updatedAt: item.updatedAt,
  };
}

function who(login: string | null): string {
  return login ? `@${login}` : 'a deleted account';
}

function commentHeading(comment: IssueComment): string {
  const at = comment.createdAt ? ` at ${comment.createdAt}` : '';
  switch (comment.kind) {
    case 'review':
      return `${who(comment.author)} reviewed (${(comment.reviewState ?? 'commented').toLowerCase().replace(/_/g, ' ')})${at}`;
    case 'review_comment':
      return `${who(comment.author)} commented on ${comment.path ?? 'the diff'}${comment.line ? ` line ${comment.line}` : ''}${at}`;
    default:
      return `${who(comment.author)} commented${at}`;
  }
}

/**
 * Resolves GitHub references for messages and the `#` autocomplete: through
 * the GitHub App's installations only (see {@link GitHubIssues}), and turns
 * them into untrusted context for Claude with limits on its size.
 */
@Injectable()
export class GitHubReferencesService {
  private readonly logger = new Logger(GitHubReferencesService.name);

  constructor(private readonly issues: GitHubIssues) {}

  /**
   * Issues and pull requests of the repositories matching what was typed
   * after `#`: a number (prefix), words of the title, or nothing (the most
   * recently updated). Repositories that cannot be searched are reported
   * in `errors`; the others still answer.
   */
  async search(
    query: string,
    repositories: string[],
  ): Promise<GitHubReferenceSearchResponse> {
    const text = query.trim();
    if (text.length > MAX_QUERY_LENGTH) {
      throw new BadRequestException(
        `query must be at most ${MAX_QUERY_LENGTH} characters`,
      );
    }
    if (repositories.length > MAX_SEARCHED_REPOSITORIES) {
      throw new BadRequestException(
        `At most ${MAX_SEARCHED_REPOSITORIES} repositories can be searched`,
      );
    }
    for (const repository of repositories) {
      if (!isRepositoryFullName(repository)) {
        throw new BadRequestException(
          `${repository} is not a GitHub repository name`,
        );
      }
    }
    const errors: string[] = [];
    const found = await Promise.all(
      repositories.map(async (name) => {
        try {
          return await this.searchRepository(
            await this.issues.repository(name),
            text,
            errors,
          );
        } catch (error) {
          errors.push(`${name}: ${referenceError(error)}`);
          return [];
        }
      }),
    );
    const exact = /^\d+$/.test(text) ? Number(text) : null;
    const seen = new Set<string>();
    const results = found
      .flat()
      .filter((item) => {
        const key = referenceKey(item.repository, item.number);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .sort(
        (a, b) =>
          Number(b.number === exact) - Number(a.number === exact) ||
          Number(b.state === 'open') - Number(a.state === 'open') ||
          (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
      )
      .slice(0, MAX_SUGGESTIONS)
      .map(summary);
    return { results, errors };
  }

  /** An issue or pull request for the preview. */
  async detail(
    repository: string,
    issueNumber: number,
  ): Promise<GitHubReferenceDetail> {
    if (!isRepositoryFullName(repository)) {
      throw new BadRequestException(
        `${repository} is not a GitHub repository name`,
      );
    }
    let item: IssueItem;
    try {
      item = await this.issues.item(
        await this.issues.repository(repository),
        issueNumber,
      );
    } catch (error) {
      if (error instanceof RepositoryNotAccessibleError) {
        throw new HttpException(error.message, 404);
      }
      throw error;
    }
    const body = cut(item.body, PREVIEW_BODY);
    return {
      ...summary(item),
      body: body.text,
      bodyTruncated: body.cut,
      labels: item.labels,
      comments: item.comments,
      createdAt: item.createdAt,
      closedAt: item.closedAt,
      pull: item.pull,
    };
  }

  /**
   * Resolves the references of a message. Never throws for GitHub
   * problems: a reference that cannot be resolved (not found, no access,
   * rate limit, GitHub unreachable, slower than
   * {@link RESOLVE_DEADLINE_MS}) is `failed`, and the context tells Claude
   * that its content is missing.
   */
  async resolve(
    requests: MessageReferenceRequest[],
    { deadlineMs = RESOLVE_DEADLINE_MS }: { deadlineMs?: number } = {},
  ): Promise<ResolvedReferences> {
    if (requests.length === 0) {
      return { references: [], context: null };
    }
    const resolved = await Promise.all(
      requests.map((request) =>
        withDeadline(this.resolveOne(request), deadlineMs).catch(
          (error: unknown) => {
            this.logger.warn(
              `${request.repository}#${request.number} could not be resolved: ${referenceError(error)}`,
            );
            return this.failed(request, referenceError(error));
          },
        ),
      ),
    );
    this.fitTotal(resolved);
    return {
      references: resolved.map((entry) => entry.reference),
      context: {
        source: 'GitHub',
        purpose:
          "the issues and pull requests the user's next message refers to",
        items: resolved.map((entry) => entry.item),
      },
    };
  }

  // -------------------------------------------------------------------------

  private async searchRepository(
    repository: GitHubRepository,
    text: string,
    errors: string[],
  ): Promise<IssueItem[]> {
    const recent = await this.issues.recent(repository);
    if (text === '') {
      return recent;
    }
    if (/^\d+$/.test(text)) {
      const matches = recent.filter((item) =>
        String(item.number).startsWith(text),
      );
      const wanted = Number(text);
      if (wanted > 0 && !matches.some((item) => item.number === wanted)) {
        try {
          matches.unshift(await this.issues.item(repository, wanted));
        } catch (error) {
          if (
            !(error instanceof GitHubApiError && error.githubStatus === 404)
          ) {
            throw error;
          }
        }
      }
      return matches;
    }
    const words = text.toLowerCase().split(/\s+/);
    const matches = recent.filter((item) =>
      words.every((word) => item.title.toLowerCase().includes(word)),
    );
    if (text.length >= 2) {
      try {
        matches.push(...(await this.issues.search(repository, text)));
      } catch (error) {
        // The recent ones still answer.
        errors.push(`${repository.fullName}: ${referenceError(error)}`);
      }
    }
    return matches;
  }

  private async resolveOne(
    request: MessageReferenceRequest,
  ): Promise<{ reference: MessageReference; item: UntrustedItem }> {
    const repository = await this.issues.repository(request.repository);
    const item = await this.issues.item(repository, request.number);
    const notes: string[] = [];
    const [comments, diff] = await Promise.all([
      request.comments
        ? this.issues.comments(repository, item).catch((error: unknown) => {
            notes.push(
              `Comments could not be loaded: ${referenceError(error)}`,
            );
            return null;
          })
        : Promise.resolve(null),
      request.diff && item.kind === 'pull_request'
        ? this.issues.diff(repository, item).catch((error: unknown) => {
            notes.push(
              `The diff could not be loaded: ${referenceError(error)}`,
            );
            return null;
          })
        : Promise.resolve(null),
    ]);
    if (request.diff && item.kind !== 'pull_request') {
      notes.push('No diff: this is an issue, not a pull request');
    }
    const content = this.content(item, request, comments, diff, notes);
    return {
      reference: {
        token: request.token,
        repository: item.repository,
        number: item.number,
        comments: request.comments ?? false,
        diff: request.diff ?? false,
        status: 'resolved',
        kind: item.kind,
        title: item.title,
        state: item.state,
        draft: item.draft,
        url: item.url,
        error: null,
        notes,
      },
      item: {
        attributes: {
          ref: `${item.repository}#${item.number}`,
          kind: item.kind === 'pull_request' ? 'pull request' : 'issue',
          state: item.draft && item.state === 'open' ? 'draft' : item.state,
          author: item.author ?? 'deleted account',
          url: item.url,
        },
        content,
      },
    };
  }

  /** What Claude gets for one issue or pull request. */
  private content(
    item: IssueItem,
    request: MessageReferenceRequest,
    comments: IssueComments | null,
    diff: PullDiff | null,
    notes: string[],
  ): string {
    const lines: string[] = [];
    const kind = item.kind === 'pull_request' ? 'Pull request' : 'Issue';
    lines.push(`${kind} ${item.repository}#${item.number}: ${item.title}`);
    lines.push(
      `State: ${item.draft && item.state === 'open' ? 'open (draft)' : item.state} · Author: ${who(item.author)}` +
        (item.createdAt ? ` · Created: ${item.createdAt}` : '') +
        (item.updatedAt ? ` · Updated: ${item.updatedAt}` : ''),
    );
    if (item.labels.length > 0) {
      lines.push(`Labels: ${item.labels.join(', ')}`);
    }
    if (item.pull) {
      lines.push(
        `Branch: ${item.pull.headBranch} into ${item.pull.baseBranch} · ${number(item.pull.changedFiles)} files changed, +${number(item.pull.additions)} -${number(item.pull.deletions)}`,
      );
    }
    const body = cut(item.body.trim(), CONTEXT_LIMITS.body);
    lines.push('', `Description by ${who(item.author)}:`);
    lines.push(body.text || '(no description)');
    if (body.cut) {
      const note = `The description was cut after ${number(body.text.length)} of ${number(item.body.length)} characters`;
      notes.push(note);
      lines.push(`[${note}.]`);
    }
    const commentCount = item.comments + (item.pull?.reviewComments ?? 0);
    if (comments) {
      lines.push('', ...this.commentLines(comments, notes));
    } else if (!request.comments && commentCount > 0) {
      lines.push(
        '',
        `[${number(commentCount)} comment(s) not included: the user did not ask for them.]`,
      );
    }
    if (diff) {
      const shown = cut(diff.text, CONTEXT_LIMITS.diff);
      lines.push(
        '',
        diff.source === 'diff'
          ? 'Diff:'
          : 'Diff (GitHub refused the whole diff as too large; changes per file):',
        shown.text,
      );
      if (shown.cut) {
        const note = `The diff was cut after ${number(shown.text.length)} of ${number(diff.text.length)} characters`;
        notes.push(note);
        lines.push(`[${note}.]`);
      }
      if (diff.omittedFiles > 0) {
        const note = `${number(diff.omittedFiles)} changed file(s) left out of the diff`;
        notes.push(note);
        lines.push(`[${note}.]`);
      }
    } else if (!request.diff && item.kind === 'pull_request') {
      lines.push(
        '',
        '[The diff is not included: the user did not ask for it.]',
      );
    }
    // What the user asked for but could not be loaded.
    for (const note of notes) {
      if (note.includes(' could not be loaded: ')) {
        lines.push('', `[${note}.]`);
      }
    }
    return lines.join('\n');
  }

  private commentLines(comments: IssueComments, notes: string[]): string[] {
    const blocks = comments.items
      .slice(-CONTEXT_LIMITS.comments)
      .map((comment) => {
        const body = cut(comment.body.trim(), CONTEXT_LIMITS.comment);
        return {
          text: `--- ${commentHeading(comment)}:\n${body.text || '(no text)'}${body.cut ? `\n[Comment cut after ${number(body.text.length)} of ${number(comment.body.length)} characters.]` : ''}`,
          cut: body.cut,
        };
      });
    // Older comments go first when all of them are too long together.
    let total = blocks.reduce((sum, block) => sum + block.text.length, 0);
    while (blocks.length > 1 && total > CONTEXT_LIMITS.commentsTotal) {
      total -= (blocks.shift() as { text: string }).text.length;
    }
    const left = comments.total - blocks.length;
    const lines = [
      left > 0
        ? `Comments (the latest ${number(blocks.length)} of ${number(comments.total)}, oldest first; ${number(left)} older one(s) left out):`
        : `Comments (${number(blocks.length)}, oldest first):`,
    ];
    if (blocks.length === 0) {
      lines.push('(none)');
    }
    lines.push(...blocks.map((block) => block.text));
    if (left > 0) {
      notes.push(
        `Only the latest ${number(blocks.length)} of ${number(comments.total)} comments were included`,
      );
    }
    const longOnes = blocks.filter((block) => block.cut).length;
    if (longOnes > 0) {
      notes.push(`${number(longOnes)} long comment(s) were cut`);
    }
    return lines;
  }

  private failed(
    request: MessageReferenceRequest,
    error: string,
  ): { reference: MessageReference; item: UntrustedItem } {
    return {
      reference: {
        token: request.token,
        repository: request.repository,
        number: request.number,
        comments: request.comments ?? false,
        diff: request.diff ?? false,
        status: 'failed',
        kind: null,
        title: null,
        state: null,
        draft: false,
        url: referenceUrl(request.repository, request.number, null),
        error,
        notes: [],
      },
      item: {
        attributes: {
          ref: `${request.repository}#${request.number}`,
          status: 'unavailable',
        },
        content: `The app could not fetch ${request.repository}#${request.number} from GitHub (${error}). Its content is missing: do not guess it. If it matters for the request, tell the user.`,
      },
    };
  }

  /** Cuts the last items when the whole context is too large. */
  private fitTotal(
    resolved: { reference: MessageReference; item: UntrustedItem }[],
  ): void {
    let total = resolved.reduce(
      (sum, entry) => sum + entry.item.content.length,
      0,
    );
    for (let index = resolved.length - 1; index >= 0; index--) {
      if (total <= CONTEXT_LIMITS.total) {
        return;
      }
      const entry = resolved[index];
      const keep = Math.max(
        2_000,
        entry.item.content.length - (total - CONTEXT_LIMITS.total),
      );
      if (keep >= entry.item.content.length) {
        continue;
      }
      const note = `Cut after ${number(keep)} characters to keep the message's GitHub context under ${number(CONTEXT_LIMITS.total)} characters`;
      total -= entry.item.content.length - keep;
      entry.item.content = `${cut(entry.item.content, keep).text}\n[${note}.]`;
      entry.reference.notes.push(note);
    }
  }
}
