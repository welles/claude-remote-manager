import {
  GitHubApiError,
  GitHubRateLimitError,
  GitHubUnavailableError,
} from './github-errors';

/** `fetch` or a fake of it (tests). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Injection token for the fetch function the GitHub client uses. */
export const GITHUB_FETCH = Symbol('GITHUB_FETCH');

export const GITHUB_API_URL = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export interface GitHubRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path below the API URL, e.g. `/app/installations`. */
  path: string;
  /** App JWT or installation token. */
  token: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /**
   * Media type to ask for instead of JSON, e.g.
   * `application/vnd.github.diff`; the response body is then returned as
   * text.
   */
  accept?: string;
  /**
   * For text answers (`accept` set): keep only the last `bytes` bytes and
   * stop reading after `maxRead` bytes (e.g. CI logs, which can be large).
   */
  tail?: { bytes: number; maxRead: number };
}

export interface GitHubResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export interface GitHubHttpOptions {
  apiUrl?: string;
  /** Longest rate-limit wait that is waited out instead of failing. */
  maxRateLimitWaitMs?: number;
  /** Timeout of one request. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const RETRIES = 2;

/**
 * The end of a response body: at most `bytes` bytes, read from at most the
 * first `maxRead` bytes of the body (the rest is not downloaded). Decoded as
 * UTF-8; a character cut at the start is dropped.
 */
export async function readTail(
  response: Response,
  { bytes, maxRead }: { bytes: number; maxRead: number },
): Promise<string> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  let chunks: Uint8Array[] = [];
  let kept = 0;
  let read = 0;
  try {
    while (read < maxRead) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      read += value.byteLength;
      chunks.push(value);
      kept += value.byteLength;
      while (chunks.length > 1 && kept - chunks[0].byteLength >= bytes) {
        kept -= chunks[0].byteLength;
        chunks = chunks.slice(1);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const all = Buffer.concat(chunks);
  let start = Math.max(0, all.length - bytes);
  // Skip UTF-8 continuation bytes of a character cut at the start.
  while (start < all.length && start > 0 && (all[start] & 0xc0) === 0x80) {
    start++;
  }
  return all.subarray(start).toString('utf8');
}

/** `<https://…?page=2>; rel="next", …` → the next URL. */
export function nextLink(header: string | null): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Minimal GitHub REST client on `fetch`: JSON in and out, API version
 * header, pagination over `Link`, and the error cases the integration has
 * to handle:
 * - primary rate limit (`x-ratelimit-remaining: 0`) and secondary rate
 *   limits (`retry-after` or the documented message): short waits are
 *   waited out, longer ones end in a {@link GitHubRateLimitError} naming
 *   the time to retry;
 * - GitHub unreachable (network error, timeout, 502/503/504 after a retry):
 *   {@link GitHubUnavailableError};
 * - other errors: {@link GitHubApiError} with GitHub's message.
 *
 * Plain fetch instead of Octokit: the integration uses a handful of
 * endpoints, the `@octokit/*` packages are ES modules only (the API bundle is
 * CommonJS), and token handling stays visible in one place.
 */
export class GitHubHttp {
  private readonly apiUrl: string;
  private readonly maxWaitMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    options: GitHubHttpOptions = {},
  ) {
    this.apiUrl = (options.apiUrl ?? GITHUB_API_URL).replace(/\/+$/, '');
    this.maxWaitMs = options.maxRateLimitWaitMs ?? 10_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async request<T>(request: GitHubRequest): Promise<GitHubResponse<T>> {
    const url = new URL(this.apiUrl + request.path);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
    return this.send<T>(url.toString(), request);
  }

  /**
   * All items of a paginated list. `select` picks the items from a page
   * (installation endpoints wrap them in an object). Stops after `maxPages`.
   */
  async paginate<P, T>(
    request: GitHubRequest,
    select: (page: P) => T[],
    maxPages = 50,
  ): Promise<T[]> {
    const items: T[] = [];
    let response = await this.request<P>({
      ...request,
      query: { per_page: 100, ...request.query },
    });
    items.push(...select(response.data));
    for (let page = 1; page < maxPages; page++) {
      const next = nextLink(response.headers.get('link'));
      if (!next || !next.startsWith(this.apiUrl)) {
        break;
      }
      response = await this.send<P>(next, { ...request, method: 'GET' });
      items.push(...select(response.data));
    }
    return items;
  }

  private async send<T>(
    url: string,
    request: GitHubRequest,
  ): Promise<GitHubResponse<T>> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: request.method ?? 'GET',
          headers: {
            Accept: request.accept ?? 'application/vnd.github+json',
            Authorization: `Bearer ${request.token}`,
            'X-GitHub-Api-Version': API_VERSION,
            'User-Agent': 'claude-remote-manager',
            ...(request.body !== undefined
              ? { 'Content-Type': 'application/json' }
              : {}),
          },
          body:
            request.body !== undefined
              ? JSON.stringify(request.body)
              : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt < 1) {
          await this.sleep(1000);
          continue;
        }
        throw new GitHubUnavailableError(
          error instanceof Error
            ? ((error.cause as Error | undefined)?.message ?? error.message)
            : String(error),
        );
      }
      if (response.ok) {
        const text =
          request.tail && request.accept
            ? await readTail(response, request.tail)
            : await response.text();
        return {
          status: response.status,
          data: (request.accept ? text : text ? JSON.parse(text) : null) as T,
          headers: response.headers,
        };
      }
      const body = await this.errorBody(response);
      const limit = this.rateLimit(response, body.message);
      if (limit) {
        const waitMs = limit.resetAt.getTime() - this.now();
        if (attempt < RETRIES && waitMs <= this.maxWaitMs) {
          await this.sleep(Math.max(waitMs, 0) + 250);
          continue;
        }
        throw new GitHubRateLimitError(limit.resetAt, limit.secondary);
      }
      if ([502, 503, 504].includes(response.status)) {
        if (attempt < 1) {
          await this.sleep(1000);
          continue;
        }
        throw new GitHubUnavailableError(`HTTP ${response.status}`);
      }
      throw new GitHubApiError(response.status, body.message, body.details);
    }
  }

  private async errorBody(
    response: Response,
  ): Promise<{ message: string; details: string[] }> {
    let message = `HTTP ${response.status}`;
    const details: string[] = [];
    try {
      const body = (await response.json()) as {
        message?: unknown;
        errors?: unknown;
      };
      if (typeof body.message === 'string' && body.message) {
        message = body.message;
      }
      if (Array.isArray(body.errors)) {
        for (const entry of body.errors as unknown[]) {
          if (typeof entry === 'string') {
            details.push(entry);
          } else if (entry && typeof entry === 'object') {
            const item = entry as Record<string, unknown>;
            const text = item['message'] ?? item['code'];
            if (typeof text === 'string') {
              details.push(
                typeof item['field'] === 'string'
                  ? `${item['field']}: ${text}`
                  : text,
              );
            }
          }
        }
      }
    } catch {
      // not JSON
    }
    return { message, details };
  }

  /**
   * Rate limit of an error response, see GitHub's "Rate limits for the REST
   * API": `retry-after` (seconds), else `x-ratelimit-reset` when nothing
   * remains, else at least a minute for a secondary limit.
   */
  private rateLimit(
    response: Response,
    message: string,
  ): { resetAt: Date; secondary: boolean } | null {
    if (response.status !== 403 && response.status !== 429) {
      return null;
    }
    const headers = response.headers;
    const secondary = /secondary rate limit/i.test(message);
    const retryAfter = Number(headers.get('retry-after'));
    if (headers.get('retry-after') !== null && Number.isFinite(retryAfter)) {
      return {
        resetAt: new Date(this.now() + retryAfter * 1000),
        secondary,
      };
    }
    if (headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(headers.get('x-ratelimit-reset'));
      return {
        resetAt: new Date(
          Number.isFinite(reset) && reset > 0
            ? reset * 1000
            : this.now() + 60_000,
        ),
        secondary: false,
      };
    }
    if (secondary || response.status === 429) {
      return { resetAt: new Date(this.now() + 60_000), secondary: true };
    }
    return null;
  }
}
