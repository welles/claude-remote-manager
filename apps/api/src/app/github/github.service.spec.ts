import { GitHubAppCredentials } from './github-app-credentials';
import { GitHubRateLimitError } from './github-errors';
import { GitHubHttp } from './github-http';
import { GitHubService, githubFullName } from './github.service';
import { InstallationTokens } from './installation-tokens';
import { FakeGitHub } from './testing/fake-github';

describe('GitHubService', () => {
  let github: FakeGitHub;

  beforeEach(() => {
    github = new FakeGitHub();
  });

  it('reports that GitHub is not configured', async () => {
    const credentials = GitHubAppCredentials.load(null, {});
    const http = new GitHubHttp(github.fetch);
    const service = new GitHubService(
      credentials,
      http,
      new InstallationTokens(credentials, http),
    );
    expect(await service.status()).toMatchObject({
      configured: false,
      problem: 'GITHUB_APP_ID is not set',
      installations: [],
    });
    expect(() => service.listing()).toThrow('not configured');
    expect(github.requests).toHaveLength(0);
  });

  it('lists repositories of all installations, page by page', async () => {
    github.pageSize = 2;
    const user = github.addInstallation('alice');
    const org = github.addInstallation('acme', 'Organization');
    for (const name of ['zeta', 'alpha', 'beta']) {
      github.addRepository(user, name);
    }
    github.addRepository(org, 'Gamma', { private: false });
    const listing = await github.service.listing();
    expect(
      listing.repositories.map((repository) => repository.fullName),
    ).toEqual(['acme/Gamma', 'alice/alpha', 'alice/beta', 'alice/zeta']);
    expect(listing.repositories[0]).toMatchObject({
      installationId: org.id,
      private: false,
      defaultBranch: 'main',
    });
    expect(listing.counts.get(user.id)).toBe(3);
    // Two pages for alice, one for acme.
    expect(
      github.requestsTo('GET', /^\/installation\/repositories$/),
    ).toHaveLength(3);
    // Listing tokens can read metadata only.
    for (const token of github.tokens) {
      expect(token.permissions).toEqual({ metadata: 'read' });
    }
  });

  it('caches the listing briefly', async () => {
    github.addRepository(github.addInstallation('alice'), 'one');
    await github.service.listing();
    await github.service.listing();
    expect(github.requestsTo('GET', /^\/app\/installations$/)).toHaveLength(1);
    await github.service.listing(true);
    expect(github.requestsTo('GET', /^\/app\/installations$/)).toHaveLength(2);
  });

  it('keeps listing other installations when one fails', async () => {
    const broken = github.addInstallation('broken');
    github.addRepository(github.addInstallation('alice'), 'one');
    github.intercept = (request) =>
      request.path === `/app/installations/${broken.id}/access_tokens`
        ? new Response(
            JSON.stringify({ message: 'This installation has been suspended' }),
            { status: 403 },
          )
        : undefined;
    const listing = await github.service.listing();
    expect(
      listing.repositories.map((repository) => repository.fullName),
    ).toEqual(['alice/one']);
    expect(listing.errors.get(broken.id)).toContain('suspended');
    const status = await github.service.status();
    expect(status).toMatchObject({
      configured: true,
      appSlug: 'test-app',
      installUrl: 'https://github.com/apps/test-app/installations/new',
    });
    expect(status.installations).toEqual([
      expect.objectContaining({
        account: 'broken',
        repositoryCount: null,
        error: expect.stringContaining('suspended'),
      }),
      expect.objectContaining({
        account: 'alice',
        repositoryCount: 1,
        error: null,
      }),
    ]);
  });

  it('shows rate limits in the status instead of failing', async () => {
    github.intercept = () =>
      new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        },
      });
    const status = await github.service.status();
    expect(status.error).toContain('rate limit');
    await expect(github.service.listing()).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });

  it('creates pull requests with a pull-request token and finds existing ones', async () => {
    const installation = github.addInstallation('alice');
    const repository = github.addRepository(installation, 'app');
    const input = {
      title: 'Fix',
      body: 'Body',
      head: 'claude/x',
      base: 'main',
    };
    const created = await github.service.createPullRequest(
      installation.id,
      repository.id,
      'alice/app',
      input,
    );
    expect(created).toMatchObject({
      number: 1,
      state: 'open',
      existing: false,
      headBranch: 'claude/x',
      baseBranch: 'main',
      url: 'https://github.com/alice/app/pull/1',
    });
    const token = github.tokens.at(-1);
    expect(token?.repositoryIds).toEqual([repository.id]);
    expect(token?.permissions).toEqual({
      pull_requests: 'write',
      contents: 'read',
    });
    const again = await github.service.createPullRequest(
      installation.id,
      repository.id,
      'alice/app',
      input,
    );
    expect(again).toMatchObject({ number: 1, existing: true });
  });

  it('explains a missing head branch', async () => {
    const installation = github.addInstallation('alice');
    const repository = github.addRepository(installation, 'app');
    github.headExists = () => false;
    await expect(
      github.service.createPullRequest(
        installation.id,
        repository.id,
        'alice/app',
        { title: 't', body: '', head: 'claude/x', base: 'main' },
      ),
    ).rejects.toThrow('push it first');
  });

  it('creates repositories in organizations and revokes the admin token', async () => {
    const org = github.addInstallation('acme', 'Organization');
    const [installation] = await github.service.installations();
    const created = await github.service.createRepository({
      installation,
      name: 'new-tool',
      private: true,
      description: null,
    });
    expect(created).toMatchObject({ owner: 'acme', name: 'new-tool' });
    expect(org.repositories.map((repository) => repository.name)).toEqual([
      'new-tool',
    ]);
    expect(github.requestsTo('POST', /^\/orgs\/acme\/repos$/)).toHaveLength(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(github.tokens.at(-1)).toMatchObject({
      permissions: { administration: 'write', metadata: 'read' },
      revoked: true,
    });
  });

  it('explains when GitHub refuses a repository in a personal account', async () => {
    github.addInstallation('alice');
    const [installation] = await github.service.installations();
    await expect(
      github.service.createRepository({
        installation,
        name: 'x',
        private: true,
        description: null,
      }),
    ).rejects.toThrow('attach it to the project instead');
    github.userRepositoryCreation = true;
    await expect(
      github.service.createRepository({
        installation,
        name: 'x',
        private: true,
        description: null,
      }),
    ).resolves.toMatchObject({ owner: 'alice', name: 'x' });
  });

  it('parses GitHub clone URLs', () => {
    expect(githubFullName('https://github.com/acme/app.git')).toBe('acme/app');
    expect(githubFullName('https://GitHub.com/acme/app')).toBe('acme/app');
    expect(githubFullName('git@github.com:acme/app.git')).toBeNull();
    expect(githubFullName('https://gitlab.com/acme/app.git')).toBeNull();
    expect(githubFullName(null)).toBeNull();
  });
});
