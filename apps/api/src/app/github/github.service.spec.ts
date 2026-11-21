import type { Logger } from '@nestjs/common';
import { GitHubAppCredentials } from './github-app-credentials';
import { GitHubRateLimitError } from './github-errors';
import { GitHubHttp } from './github-http';
import { GitHubService, githubFullName, mergeConflict } from './github.service';
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

  describe("the app's setup", () => {
    it('reports nothing missing when the app has every permission', async () => {
      github.addInstallation('alice');
      github.service.expectsWebhook = true;
      const status = await github.service.status();
      expect(status.setup).toEqual({
        permissions: [],
        events: [],
        webhook: true,
      });
      expect(status.installations[0]).toMatchObject({
        missingPermissions: [],
        missingEvents: [],
      });
    });

    it('reports permissions and events the app lacks, and what installations have not accepted', async () => {
      const alice = github.addInstallation('alice');
      github.addInstallation('acme', 'Organization');
      // No Actions permission, Contents only read.
      const { actions: _actions, ...withoutActions } = github.appPermissions;
      github.appPermissions = { ...withoutActions, contents: 'read' };
      github.appEvents = github.appEvents.filter(
        (event) => event !== 'pull_request_review_thread',
      );
      // alice has not accepted the new checks permission and an event yet.
      alice.permissions = { ...github.appPermissions };
      delete alice.permissions['checks'];
      alice.events = github.appEvents.filter((event) => event !== 'status');
      github.service.expectsWebhook = true;

      const status = await github.service.status();
      expect(status.setup).toEqual({
        permissions: [
          {
            permission: 'contents',
            needed: 'write',
            granted: 'read',
            usedFor: expect.any(String),
          },
          {
            permission: 'actions',
            needed: 'read',
            granted: null,
            usedFor: expect.any(String),
          },
        ],
        events: ['pull_request_review_thread'],
        webhook: true,
      });
      // The app's own gaps are not repeated per installation.
      expect(status.installations).toEqual([
        expect.objectContaining({
          account: 'alice',
          missingPermissions: [
            expect.objectContaining({ permission: 'checks', granted: null }),
          ],
          missingEvents: ['status'],
        }),
        expect.objectContaining({
          account: 'acme',
          missingPermissions: [],
          missingEvents: [],
        }),
      ]);
    });

    it('counts too low access as missing, and admin as enough', async () => {
      const alice = github.addInstallation('alice');
      github.appPermissions = { ...github.appPermissions, contents: 'admin' };
      alice.permissions = { ...github.appPermissions, pull_requests: 'read' };
      const status = await github.service.status();
      expect(status.setup?.permissions).toEqual([]);
      expect(status.installations[0].missingPermissions).toEqual([
        expect.objectContaining({
          permission: 'pull_requests',
          needed: 'write',
          granted: 'read',
        }),
      ]);
    });

    it('reads GitHub again on refresh, after the app settings were fixed', async () => {
      github.addInstallation('alice');
      const { actions: _actions, ...withoutActions } = github.appPermissions;
      github.appPermissions = withoutActions;
      expect((await github.service.status()).setup?.permissions).toHaveLength(
        1,
      );
      github.appPermissions = { ...withoutActions, actions: 'read' };
      // Cached without refresh, read again with it.
      expect((await github.service.status()).setup?.permissions).toHaveLength(
        1,
      );
      expect((await github.service.status(true)).setup?.permissions).toEqual(
        [],
      );
    });

    it('keeps the setup report when the installations cannot be read', async () => {
      github.addInstallation('alice');
      github.appPermissions = { ...github.appPermissions, issues: 'none' };
      github.intercept = (request) =>
        request.path === '/app/installations'
          ? new Response(JSON.stringify({ message: 'Server Error' }), {
              status: 500,
            })
          : undefined;
      const status = await github.service.status();
      expect(status.error).not.toBeNull();
      expect(status.setup?.permissions).toEqual([
        expect.objectContaining({ permission: 'issues' }),
      ]);
    });

    it('checks at startup without failing it, and not without configuration', async () => {
      const warnings: string[] = [];
      const logger = (github.service as unknown as { logger: Logger }).logger;
      const warn = jest
        .spyOn(logger, 'warn')
        .mockImplementation((message: unknown) => {
          warnings.push(String(message));
        });
      github.intercept = (request) =>
        request.path === '/app'
          ? new Response(JSON.stringify({ message: 'Bad credentials' }), {
              status: 401,
            })
          : undefined;
      github.service.onApplicationBootstrap();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(warnings).toEqual([
        expect.stringContaining("Could not check the GitHub App's permissions"),
      ]);
      warn.mockRestore();

      const credentials = GitHubAppCredentials.load(null, {});
      const http = new GitHubHttp(github.fetch);
      const unconfigured = new GitHubService(
        credentials,
        http,
        new InstallationTokens(credentials, http),
      );
      const before = github.requests.length;
      unconfigured.onApplicationBootstrap();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(github.requests).toHaveLength(before);
    });

    it('checks webhook events only with a webhook secret', async () => {
      github.addInstallation('alice');
      github.appEvents = [];
      const status = await github.service.status();
      expect(status.setup).toEqual({
        permissions: [],
        events: [],
        webhook: false,
      });
      expect(status.installations[0].missingEvents).toEqual([]);
    });

    it('logs what is missing at startup', async () => {
      const alice = github.addInstallation('alice');
      github.appPermissions = { ...github.appPermissions, issues: 'none' };
      alice.permissions = { ...github.appPermissions };
      delete alice.permissions['workflows'];
      const warnings: string[] = [];
      const logger = (github.service as unknown as { logger: Logger }).logger;
      jest.spyOn(logger, 'warn').mockImplementation((message: unknown) => {
        warnings.push(String(message));
      });
      await github.service.checkSetup();
      expect(warnings).toEqual([
        expect.stringContaining(
          'the app lacks the permission issues: read needed',
        ),
        expect.stringContaining(
          'the installation on alice has not accepted workflows: write needed',
        ),
      ]);
    });
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

  it('refuses repositories in personal accounts without asking GitHub', async () => {
    github.addInstallation('alice');
    const [installation] = await github.service.installations();
    const before = github.requests.length;
    await expect(
      github.service.createRepository({
        installation,
        name: 'x',
        private: true,
        description: null,
      }),
    ).rejects.toThrow('attach it to the project instead');
    expect(github.requests.length).toBe(before);
  });

  it('parses GitHub clone URLs', () => {
    expect(githubFullName('https://github.com/acme/app.git')).toBe('acme/app');
    expect(githubFullName('https://GitHub.com/acme/app')).toBe('acme/app');
    expect(githubFullName('git@github.com:acme/app.git')).toBeNull();
    expect(githubFullName('https://gitlab.com/acme/app.git')).toBeNull();
    expect(githubFullName(null)).toBeNull();
  });
});

describe('mergeConflict', () => {
  it.each([
    [{ state: 'open', mergeable: false, mergeable_state: 'dirty' }, true],
    [{ state: 'open', mergeable: false, mergeable_state: 'draft' }, true],
    [{ state: 'open', mergeable: true, mergeable_state: 'blocked' }, false],
    [{ state: 'open', mergeable: true, mergeable_state: 'behind' }, false],
    [{ state: 'open', mergeable: null, mergeable_state: 'unknown' }, null],
    [{ state: 'open', mergeable: false, mergeable_state: 'unknown' }, null],
    [{ state: 'open' }, null],
    [{ state: 'closed', mergeable: false, mergeable_state: 'dirty' }, null],
  ])('reads %o as %s', (raw, expected) => {
    expect(mergeConflict(raw)).toBe(expected);
  });
});
