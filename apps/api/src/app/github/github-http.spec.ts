import {
  GitHubApiError,
  GitHubRateLimitError,
  GitHubUnavailableError,
} from './github-errors';
import { GitHubHttp, nextLink, type FetchLike } from './github-http';

const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers });

/** A fetch that answers with the given responses in order. */
function scripted(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) {
      throw new Error('no more responses');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { calls, fetchImpl };
}

describe('GitHubHttp', () => {
  const sleeps: number[] = [];
  const now = () => 1_000_000;
  const client = (fetchImpl: FetchLike) =>
    new GitHubHttp(fetchImpl, {
      now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

  beforeEach(() => (sleeps.length = 0));

  it('sends JSON with token and API version', async () => {
    const { calls, fetchImpl } = scripted(json(201, { ok: true }));
    const response = await client(fetchImpl).request<{ ok: boolean }>({
      method: 'POST',
      path: '/repos/a/b/pulls',
      token: 'ghs_x',
      body: { title: 't' },
    });
    expect(response.data).toEqual({ ok: true });
    const headers = new Headers(calls[0].init.headers);
    expect(calls[0].url).toBe('https://api.github.com/repos/a/b/pulls');
    expect(headers.get('authorization')).toBe('Bearer ghs_x');
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(calls[0].init.body).toBe('{"title":"t"}');
  });

  it('follows Link headers across pages', async () => {
    const { calls, fetchImpl } = scripted(
      json(200, [1, 2], {
        link: '<https://api.github.com/items?page=2>; rel="next", <https://api.github.com/items?page=3>; rel="last"',
      }),
      json(200, [3], {
        link: '<https://api.github.com/items?page=3>; rel="next"',
      }),
      json(200, [4]),
    );
    const items = await client(fetchImpl).paginate<number[], number>(
      { path: '/items', token: 't' },
      (page) => page,
    );
    expect(items).toEqual([1, 2, 3, 4]);
    expect(calls[0].url).toBe('https://api.github.com/items?per_page=100');
    expect(calls[2].url).toBe('https://api.github.com/items?page=3');
  });

  it('does not follow links to other hosts', async () => {
    const { calls, fetchImpl } = scripted(
      json(200, [1], {
        link: '<https://evil.example/items?page=2>; rel="next"',
      }),
    );
    await client(fetchImpl).paginate<number[], number>(
      { path: '/items', token: 't' },
      (page) => page,
    );
    expect(calls).toHaveLength(1);
  });

  it('waits out a short secondary rate limit and retries', async () => {
    const { calls, fetchImpl } = scripted(
      json(
        403,
        { message: 'You have exceeded a secondary rate limit.' },
        { 'retry-after': '3' },
      ),
      json(200, { ok: 1 }),
    );
    await expect(
      client(fetchImpl).request({ path: '/x', token: 't' }),
    ).resolves.toMatchObject({ data: { ok: 1 } });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([3250]);
  });

  it('fails with the reset time on a long primary rate limit', async () => {
    const reset = 1_000_000 / 1000 + 3600;
    const { fetchImpl } = scripted(
      json(
        403,
        { message: 'API rate limit exceeded' },
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      ),
    );
    const error = await client(fetchImpl)
      .request({ path: '/x', token: 't' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).resetAt.getTime()).toBe(
      reset * 1000,
    );
    expect((error as Error).message).toContain('rate limit');
    expect(sleeps).toEqual([]);
  });

  it('reports GitHub as unreachable after a retry', async () => {
    const { calls, fetchImpl } = scripted(
      new TypeError('fetch failed', {
        cause: new Error('getaddrinfo ENOTFOUND'),
      }),
      new TypeError('fetch failed', {
        cause: new Error('getaddrinfo ENOTFOUND'),
      }),
    );
    const error = await client(fetchImpl)
      .request({ path: '/x', token: 't' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubUnavailableError);
    expect((error as Error).message).toContain('ENOTFOUND');
    expect(calls).toHaveLength(2);
  });

  it('turns other errors into GitHubApiError with details', async () => {
    const { fetchImpl } = scripted(
      json(422, {
        message: 'Validation Failed',
        errors: [{ field: 'head', code: 'invalid' }, 'other'],
      }),
    );
    const error = (await client(fetchImpl)
      .request({ path: '/x', token: 't' })
      .catch((caught: unknown) => caught)) as GitHubApiError;
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error.githubStatus).toBe(422);
    expect(error.details).toEqual(['head: invalid', 'other']);
    expect(error.getStatus()).toBe(502);
  });

  it('parses next links', () => {
    expect(nextLink(null)).toBeNull();
    expect(nextLink('<https://a/x?page=2>; rel="next"')).toBe(
      'https://a/x?page=2',
    );
    expect(nextLink('<https://a/x?page=1>; rel="prev"')).toBeNull();
  });
});
