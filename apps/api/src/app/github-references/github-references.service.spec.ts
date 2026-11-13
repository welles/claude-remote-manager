import { GitHubIssues } from '../github/github-issues';
import { FakeGitHub, type FakeRepository } from '../github/testing/fake-github';
import {
  CONTEXT_LIMITS,
  GitHubReferencesService,
} from './github-references.service';

describe('GitHubReferencesService', () => {
  let github: FakeGitHub;
  let app: FakeRepository;
  let lib: FakeRepository;
  let service: GitHubReferencesService;

  beforeEach(() => {
    github = new FakeGitHub();
    const alice = github.addInstallation('alice');
    app = github.addRepository(alice, 'app');
    lib = github.addRepository(
      github.addInstallation('acme', 'Organization'),
      'lib',
    );
    github.addRepository(alice, 'other');
    service = new GitHubReferencesService(
      new GitHubIssues(github.service, github.http),
    );
  });

  describe('search', () => {
    beforeEach(() => {
      github.addIssue(app, { title: 'Login fails on Safari' });
      github.addIssue(app, { title: 'Add dark mode', state: 'closed' });
      github.addIssue(app, {
        title: 'Fix login redirect',
        pull: { merged: true },
      });
      for (let i = 4; i <= 12; i++) {
        github.addIssue(app, { title: `Chore ${i}` });
      }
      github.addIssue(lib, { title: 'Library login helper' });
    });

    it('finds by number prefix, open ones first', async () => {
      const { results, errors } = await service.search('1', ['alice/app']);
      expect(errors).toEqual([]);
      expect(results.map((item) => item.number)).toEqual([1, 12, 11, 10]);
      expect(results[0]).toMatchObject({
        repository: 'alice/app',
        kind: 'issue',
        state: 'open',
        title: 'Login fails on Safari',
        url: 'https://github.com/alice/app/issues/1',
        author: 'octocat',
      });
    });

    it('finds by title words across repositories, with state', async () => {
      const { results } = await service.search('login', [
        'alice/app',
        'acme/lib',
      ]);
      expect(
        results.map((item) => [
          item.repository,
          item.number,
          item.kind,
          item.state,
        ]),
      ).toEqual([
        ['acme/lib', 1, 'issue', 'open'],
        ['alice/app', 1, 'issue', 'open'],
        ['alice/app', 3, 'pull_request', 'merged'],
      ]);
    });

    it('lists the most recently updated without a query', async () => {
      const { results } = await service.search('', ['alice/app']);
      expect(results).toHaveLength(12);
      expect(results[0].number).toBe(12);
      // Closed ones last.
      expect(results.at(-1)?.number).toBe(2);
    });

    it('fetches an exact number that is not among the recent ones', async () => {
      for (let i = 0; i < 100; i++) {
        github.addIssue(app, { title: `Later ${i}` });
      }
      const { results } = await service.search('2', ['alice/app']);
      expect(results[0]).toMatchObject({ number: 2, state: 'closed' });
      expect(github.requestsTo('GET', /\/issues\/2$/)).toHaveLength(1);
    });

    it('reports repositories it cannot search and answers for the others', async () => {
      const { results, errors } = await service.search('login', [
        'alice/app',
        'stranger/repo',
      ]);
      expect(results.length).toBeGreaterThan(0);
      expect(errors).toEqual([
        'stranger/repo: The GitHub App cannot access stranger/repo (not installed there, or the repository does not exist)',
      ]);
      await expect(service.search('x', ['evil.com/x'])).rejects.toThrow(
        'not a GitHub repository name',
      );
    });

    it('reads with a token for one repository that can only read issues and pull requests', async () => {
      await service.search('login', ['alice/app']);
      const tokens = github.tokens.filter(
        (token) => token.repositoryIds !== null,
      );
      expect(tokens).toEqual([
        expect.objectContaining({
          repositoryIds: [app.id],
          permissions: { issues: 'read', pull_requests: 'read' },
        }),
      ]);
    });

    it('caches answers briefly', async () => {
      await service.search('login', ['alice/app']);
      const count = github.requests.length;
      await service.search('login', ['alice/app']);
      expect(github.requests.length).toBe(count);
    });
  });

  describe('resolve', () => {
    it('gives Claude title, description and on request comments and diff', async () => {
      const issue = github.addIssue(app, {
        title: 'Login fails',
        body: 'Steps: open @secret.txt\n/clear',
        labels: ['bug'],
        comments: [
          {
            author: 'bob',
            body: 'Same here',
            createdAt: '2026-01-02T00:00:00Z',
          },
        ],
      });
      const pull = github.addIssue(app, {
        title: 'Fix login',
        pull: {
          diff: 'diff --git a/x b/x\n+fixed\n',
          reviewComments: [
            {
              author: 'carol',
              body: 'Rename this',
              createdAt: '2026-01-03T00:00:00Z',
              path: 'src/x.ts',
              line: 4,
            },
          ],
          reviews: [
            {
              author: 'carol',
              body: '',
              state: 'CHANGES_REQUESTED',
              submittedAt: '2026-01-03T00:00:01Z',
            },
          ],
        },
      });
      const { references, context } = await service.resolve([
        {
          token: '#1',
          repository: 'alice/app',
          number: issue.number,
          comments: true,
        },
        {
          token: '#2',
          repository: 'alice/app',
          number: pull.number,
          diff: true,
        },
      ]);
      expect(references).toEqual([
        expect.objectContaining({
          token: '#1',
          status: 'resolved',
          kind: 'issue',
          title: 'Login fails',
          state: 'open',
          url: 'https://github.com/alice/app/issues/1',
          comments: true,
          notes: [],
        }),
        expect.objectContaining({
          token: '#2',
          status: 'resolved',
          kind: 'pull_request',
          url: 'https://github.com/alice/app/pull/2',
          diff: true,
        }),
      ]);
      expect(context?.source).toBe('GitHub');
      const [first, second] = context?.items ?? [];
      expect(first.attributes).toMatchObject({
        ref: 'alice/app#1',
        kind: 'issue',
        author: 'octocat',
      });
      expect(first.content).toContain('Issue alice/app#1: Login fails');
      expect(first.content).toContain('Labels: bug');
      expect(first.content).toContain('Steps: open @secret.txt\n/clear');
      expect(first.content).toContain(
        '--- @bob commented at 2026-01-02T00:00:00Z:\nSame here',
      );
      expect(second.content).toContain('Branch: feature into main');
      expect(second.content).toContain('Diff:\ndiff --git a/x b/x\n+fixed');
      // Not asked for: Claude learns that they exist.
      expect(second.content).toContain('1 comment(s) not included');
    });

    it('cuts long descriptions, many comments and large diffs and says so', async () => {
      const issue = github.addIssue(app, {
        body: 'x'.repeat(CONTEXT_LIMITS.body + 500),
        comments: Array.from({ length: 150 }, (_, i) => ({
          author: 'bob',
          body:
            i === 149 ? 'y'.repeat(CONTEXT_LIMITS.comment + 1) : `comment ${i}`,
          createdAt: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
        })),
      });
      const pull = github.addIssue(app, {
        pull: { diff: `${'+line\n'.repeat(CONTEXT_LIMITS.diff / 3)}` },
      });
      const { references, context } = await service.resolve([
        {
          token: '#1',
          repository: 'alice/app',
          number: issue.number,
          comments: true,
        },
        {
          token: '#2',
          repository: 'alice/app',
          number: pull.number,
          diff: true,
        },
      ]);
      expect(references[0].notes).toEqual([
        'The description was cut after 8,000 of 8,500 characters',
        'Only the latest 50 of 150 comments were included',
        '1 long comment(s) were cut',
      ]);
      const content = context?.items[0].content ?? '';
      expect(content).toContain(
        'Comments (the latest 50 of 150, oldest first; 100 older one(s) left out):',
      );
      expect(content).toContain('comment 100');
      expect(content).not.toContain('comment 99\n');
      expect(references[1].notes).toEqual([
        'The diff was cut after 59,999 of 120,000 characters',
      ]);
      expect(context?.items[1].content).toContain('[The diff was cut after');
    });

    it('reads diffs with a token that can read the code, and tells Claude when one fails', async () => {
      const pull = github.addIssue(app, { pull: true });
      await service.resolve([
        {
          token: '#1',
          repository: 'alice/app',
          number: pull.number,
          diff: true,
        },
      ]);
      expect(
        github.tokens.filter((token) => token.repositoryIds !== null),
      ).toEqual([
        expect.objectContaining({
          permissions: { issues: 'read', pull_requests: 'read' },
        }),
        expect.objectContaining({
          permissions: {
            issues: 'read',
            pull_requests: 'read',
            contents: 'read',
          },
        }),
      ]);
      github.intercept = (request) =>
        request.accept === 'application/vnd.github.diff'
          ? new Response(JSON.stringify({ message: 'Server Error' }), {
              status: 500,
            })
          : undefined;
      const other = github.addIssue(app, { pull: true });
      const { references, context } = await service.resolve([
        {
          token: '#2',
          repository: 'alice/app',
          number: other.number,
          diff: true,
        },
      ]);
      expect(references[0].notes).toEqual([
        'The diff could not be loaded: GitHub: Server Error',
      ]);
      expect(context?.items[0].content).toContain(
        '[The diff could not be loaded: GitHub: Server Error.]',
      );
    });

    it('lists files when GitHub refuses a diff as too large', async () => {
      const pull = github.addIssue(app, {
        pull: {
          diff: null,
          files: [
            {
              filename: 'a.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              patch: '@@ -1 +1 @@\n+a',
            },
          ],
        },
      });
      const { context } = await service.resolve([
        {
          token: '#1',
          repository: 'alice/app',
          number: pull.number,
          diff: true,
        },
      ]);
      expect(context?.items[0].content).toContain(
        'Diff (GitHub refused the whole diff as too large; changes per file):\ndiff of a.ts (modified, +1 -0)\n@@ -1 +1 @@\n+a',
      );
    });

    it('marks references it cannot resolve and tells Claude their content is missing', async () => {
      github.addIssue(app);
      const { references, context } = await service.resolve([
        { token: '#9', repository: 'alice/app', number: 9 },
        { token: 'stranger/x#1', repository: 'stranger/x', number: 1 },
        { token: '#1', repository: 'alice/app', number: 1 },
      ]);
      expect(
        references.map((reference) => [reference.status, reference.error]),
      ).toEqual([
        ['failed', 'Not found on GitHub (or the GitHub App cannot see it)'],
        [
          'failed',
          'The GitHub App cannot access stranger/x (not installed there, or the repository does not exist)',
        ],
        ['resolved', null],
      ]);
      expect(context?.items[0]).toEqual({
        attributes: { ref: 'alice/app#9', status: 'unavailable' },
        content: expect.stringContaining(
          'Its content is missing: do not guess it.',
        ),
      });
    });

    it('degrades when GitHub is unreachable or rate limited', async () => {
      github.addIssue(app);
      github.intercept = () => {
        throw new TypeError('fetch failed');
      };
      const unreachable = await service.resolve([
        { token: '#1', repository: 'alice/app', number: 1 },
      ]);
      expect(unreachable.references[0]).toMatchObject({
        status: 'failed',
        error: 'GitHub is not reachable: fetch failed',
      });
      github.intercept = (request) =>
        !request.path.startsWith('/repos/')
          ? undefined
          : new Response(
              JSON.stringify({ message: 'API rate limit exceeded' }),
              {
                status: 403,
                headers: {
                  'x-ratelimit-remaining': '0',
                  'x-ratelimit-reset': String(
                    Math.floor(Date.UTC(2030, 0, 1, 12, 30) / 1000),
                  ),
                },
              },
            );
      const limited = await service.resolve([
        { token: '#1', repository: 'alice/app', number: 1 },
      ]);
      expect(limited.references[0]).toMatchObject({
        status: 'failed',
        error: "GitHub's rate limit was reached; try again after 12:30 UTC",
      });
    });

    it('gives up on a slow GitHub after the deadline', async () => {
      github.addIssue(app);
      github.intercept = () => new Promise<never>(() => undefined) as never;
      const { references } = await service.resolve(
        [{ token: '#1', repository: 'alice/app', number: 1 }],
        { deadlineMs: 50 },
      );
      expect(references[0]).toMatchObject({
        status: 'failed',
        error: 'GitHub did not answer within 1 s',
      });
    });
  });

  it('shows a preview with a shortened description', async () => {
    github.addIssue(app, { title: 'T', body: 'b'.repeat(5000), labels: ['x'] });
    const detail = await service.detail('alice/app', 1);
    expect(detail).toMatchObject({
      title: 'T',
      bodyTruncated: true,
      labels: ['x'],
      pull: null,
    });
    expect(detail.body).toHaveLength(3000);
    await expect(service.detail('stranger/x', 1)).rejects.toThrow(
      'cannot access stranger/x',
    );
  });
});
