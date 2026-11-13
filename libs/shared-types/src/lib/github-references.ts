/**
 * GitHub issues and pull requests referenced in a message (`#123`,
 * `owner/repo#123`). The input offers them with `#` autocomplete
 * (`GET /api/github/references`), shows them as chips, and sends them with
 * the message (`references`); the API fetches title, description and, on
 * request, comments and the diff through the GitHub App and gives them to
 * Claude as untrusted context together with the message.
 */

export type GitHubReferenceKind = 'issue' | 'pull_request';

export type GitHubReferenceState = 'open' | 'closed' | 'merged';

/** Most references one message can carry. */
export const MAX_REFERENCES_PER_MESSAGE = 10;

/** An issue or pull request as offered by the autocomplete. */
export interface GitHubReferenceSummary {
  /** `owner/name` as GitHub spells it. */
  repository: string;
  number: number;
  kind: GitHubReferenceKind;
  title: string;
  state: GitHubReferenceState;
  /** Draft pull request. */
  draft: boolean;
  /** Page on github.com. */
  url: string;
  /** Login of the author; `null` for deleted accounts. */
  author: string | null;
  updatedAt: string | null;
}

/** Response of `GET /api/github/references?query=&repositories=`. */
export interface GitHubReferenceSearchResponse {
  results: GitHubReferenceSummary[];
  /** Repositories that could not be searched, with the reason. */
  errors: string[];
}

/**
 * Response of `GET /api/github/references/:owner/:repo/:number`: an issue
 * or pull request for the preview. The body is GitHub Markdown written by
 * any GitHub user: render it only without remote resources.
 */
export interface GitHubReferenceDetail extends GitHubReferenceSummary {
  /** Description, shortened for the preview. */
  body: string;
  bodyTruncated: boolean;
  labels: string[];
  /** Number of comments (for pull requests without review comments). */
  comments: number;
  createdAt: string | null;
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

/** A reference sent with a message (`references` of `message.send`). */
export interface MessageReferenceRequest {
  /**
   * The reference as written in the text: `#12` (a repository of the
   * session) or `owner/repo#12`.
   */
  token: string;
  /** `owner/name` the token refers to. */
  repository: string;
  number: number;
  /** Give Claude the comments (and review comments of a pull request). */
  comments?: boolean;
  /** Give Claude the diff (pull requests only). */
  diff?: boolean;
}

/**
 * A reference of a sent message, as it was resolved when the message was
 * sent: what the chip shows and what Claude got.
 */
export interface MessageReference {
  token: string;
  repository: string;
  number: number;
  comments: boolean;
  diff: boolean;
  /** `failed`: GitHub could not be asked or the item was not found. */
  status: 'resolved' | 'failed';
  kind: GitHubReferenceKind | null;
  title: string | null;
  state: GitHubReferenceState | null;
  draft: boolean;
  url: string;
  /** Why it could not be resolved (`failed`). */
  error: string | null;
  /** What was cut or left out, e.g. older comments or part of the diff. */
  notes: string[];
}

/**
 * Response of `GET /api/sessions/:id/messages/:messageId/context`: the
 * context the app gave Claude with a message, exactly as Claude got it.
 */
export interface MessageContextResponse {
  messageId: string;
  context: string;
  references: MessageReference[];
}

/** GitHub's rules for account and organization names. */
const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}';
/** GitHub's rules for repository names. */
const NAME = '[A-Za-z0-9._-]{1,100}';

const FULL_NAME = /* @__PURE__ */ new RegExp(`^(${OWNER})/(${NAME})$`);

/**
 * Whether `owner/name` follows GitHub's naming rules (not whether it
 * exists). Only such names are ever looked up.
 */
export function isRepositoryFullName(value: string): boolean {
  const match = FULL_NAME.exec(value);
  return (
    match !== null &&
    match[2] !== '.' &&
    match[2] !== '..' &&
    !match[2].toLowerCase().endsWith('.git')
  );
}

/** Page of an issue or pull request on github.com. */
export function referenceUrl(
  repository: string,
  number: number,
  kind: GitHubReferenceKind | null,
): string {
  return `https://github.com/${repository}/${kind === 'pull_request' ? 'pull' : 'issues'}/${number}`;
}

/** A reference found in a text. */
export interface ParsedReference {
  token: string;
  /** `owner/name`; for `#12` the default repository (`null` without). */
  repository: string | null;
  number: number;
  /** Position of the token in the text. */
  start: number;
  end: number;
}

/**
 * `#12` or `owner/repo#12`, not inside a word, URL fragment, HTML entity
 * or another reference.
 */
const REFERENCE = /* @__PURE__ */ new RegExp(
  `(?<![\\w/#&.@\`-])(?:(${OWNER})/(${NAME}))?#([1-9]\\d{0,8})(?![\\w-])`,
  'g',
);

/** Ranges of Markdown code (fenced blocks and inline spans). */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const fence =
    /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|$(?![\s\S]))/gm;
  for (const match of text.matchAll(fence)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  const inline = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
  for (const match of text.matchAll(inline)) {
    const start = match.index;
    if (!ranges.some(([from, to]) => start >= from && start < to)) {
      ranges.push([start, start + match[0].length]);
    }
  }
  return ranges;
}

/**
 * The GitHub references in a text, in order: `#12` refers to
 * `defaultRepository` (the session's first GitHub repository; without one
 * `repository` is `null`), `owner/repo#12` to that repository. References
 * inside Markdown code are not references.
 */
export function parseReferences(
  text: string,
  defaultRepository: string | null,
): ParsedReference[] {
  const code = codeRanges(text);
  const found: ParsedReference[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    const start = match.index;
    if (code.some(([from, to]) => start >= from && start < to)) {
      continue;
    }
    const named = match[1] && match[2] ? `${match[1]}/${match[2]}` : null;
    if (named && !isRepositoryFullName(named)) {
      continue;
    }
    found.push({
      token: match[0],
      repository: named ?? defaultRepository,
      number: Number(match[3]),
      start,
      end: start + match[0].length,
    });
  }
  return found;
}

/** `owner/name#12`, the same for every spelling of the repository. */
export function referenceKey(repository: string, number: number): string {
  return `${repository.toLowerCase()}#${number}`;
}
