import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { credentialHelperCommand } from '../git/credential-helper';
import { GitService } from '../git/git.service';
import { git } from '../git/testing/git-fixtures';
import { GitHubAppCredentials } from '../github/github-app-credentials';
import { GITHUB_FETCH } from '../github/github-http';
import { FakeGitHub, type FakeRepository } from '../github/testing/fake-github';
import { RepositoryRepository } from '../repositories/repository.repository';
import { startTestApp, type TestApp } from '../testing/test-app';
import { ApprovalGrants } from './approval-grants';
import { SessionAgentSupport } from './session-agent-support';
import { SessionCredentials } from './session-credentials';
import { SessionRepository } from './session.repository';

const SESSION = '5b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
const OTHER = '6c3d2e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f';

interface FillResult {
  stdout: string;
  stderr: string;
  values: Record<string, string>;
}

/** Runs `git credential fill` in `cwd` like git does before a request. */
function fill(
  cwd: string,
  env: Record<string, string>,
  path = 'alice/app.git',
): Promise<FillResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['credential', 'fill'],
      {
        cwd,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: process.env['HOME'] ?? '',
          GIT_CONFIG_GLOBAL: process.env['GIT_CONFIG_GLOBAL'] ?? '',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          ...env,
        },
      },
      (error, stdout, stderr) => {
        const values = Object.fromEntries(
          stdout
            .split('\n')
            .filter((line) => line.includes('='))
            .map((line) => [
              line.slice(0, line.indexOf('=')),
              line.slice(line.indexOf('=') + 1),
            ]),
        );
        if (error && !stderr) {
          reject(error);
        } else {
          resolve({ stdout, stderr, values });
        }
      },
    );
    child.stdin?.end(`protocol=https\nhost=github.com\npath=${path}\n\n`);
  });
}

describe('git credential helper', () => {
  let app: TestApp;
  let github: FakeGitHub;
  let remote: FakeRepository;
  let clone: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    github = new FakeGitHub();
    const installation = github.addInstallation('alice');
    remote = github.addRepository(installation, 'app');
    const other = github.addRepository(installation, 'other');
    app = await startTestApp(
      {},
      {
        configure: (builder) =>
          builder
            .overrideProvider(GITHUB_FETCH)
            .useValue(github.fetch)
            .overrideProvider(GitHubAppCredentials)
            .useValue(github.credentials),
      },
    );
    app.config.internalApiUrl = `http://127.0.0.1:${app.port}`;
    const repositories = app.app.get(RepositoryRepository);
    const sessions = app.app.get(SessionRepository);
    for (const [id, repository] of [
      ['a1b2c3d4-0000-4000-8000-000000000001', remote],
      ['a1b2c3d4-0000-4000-8000-000000000002', other],
    ] as const) {
      repositories.create({
        id,
        owner: 'alice',
        name: repository.name,
        cloneUrl: `https://github.com/alice/${repository.name}.git`,
        localPath: join(app.dir, 'repos', repository.name),
        setupScript: null,
        githubRepositoryId: repository.id,
        githubInstallationId: installation.id,
      });
    }
    clone = join(app.dir, 'sessions', 's', 'alice', 'app');
    await mkdir(clone, { recursive: true });
    await git(clone, 'init', '--quiet', '--initial-branch=claude/s');
    await app.app
      .get(GitService)
      .setCredentialHelper(clone, credentialHelperCommand());
    for (const [id, path] of [
      [SESSION, clone],
      [OTHER, join(app.dir, 'sessions', 'o', 'alice', 'other')],
    ]) {
      sessions.create({
        id,
        title: null,
        model: null,
        permissionMode: 'default',
        status: 'waiting',
        slug: id.slice(0, 8),
        pendingMessage: null,
        directories: [
          {
            path,
            kind: 'clone',
            repositoryId:
              id === SESSION
                ? 'a1b2c3d4-0000-4000-8000-000000000001'
                : 'a1b2c3d4-0000-4000-8000-000000000002',
            branch: 'claude/s',
            baseBranch: 'main',
            state: 'ready',
            setupStatus: 'none',
          },
        ],
      });
    }
    env = {
      CRM_API_URL: `http://127.0.0.1:${app.port}`,
      CRM_SESSION_TOKEN: app.app.get(SessionCredentials).issue(SESSION),
    };
  });
  afterEach(() => app.close());

  it('gets a read-only token for exactly the session’s repository', async () => {
    const result = await fill(clone, env);
    expect(result.values['username']).toBe('x-access-token');
    const token = github.tokens.find(
      (entry) => entry.token === result.values['password'],
    );
    expect(token).toMatchObject({
      repositoryIds: [remote.id],
      permissions: { contents: 'read' },
    });
    expect(Number(result.values['password_expiry_utc'])).toBeGreaterThan(
      Date.now() / 1000,
    );
    expect(result.stderr).toContain('read-only token');
  });

  it('hands out a write token only during an approved push, then revokes it', async () => {
    const grants = app.app.get(ApprovalGrants);
    grants.approved(SESSION, 'Bash', { command: 'git push' }, 'tool-1', null);
    const result = await fill(clone, env);
    const token = github.tokens.find(
      (entry) => entry.token === result.values['password'],
    );
    expect(token).toMatchObject({
      repositoryIds: [remote.id],
      permissions: { contents: 'write' },
    });
    // The push command finished.
    app.app.get(SessionAgentSupport).toolFinished(SESSION, 'tool-1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(token?.revoked).toBe(true);
    const after = await fill(clone, env);
    expect(
      github.tokens.find((entry) => entry.token === after.values['password'])
        ?.permissions,
    ).toEqual({ contents: 'read' });
  });

  it('refuses repositories of other sessions and unknown tokens', async () => {
    const foreign = await fill(clone, env, 'alice/other.git');
    expect(foreign.values['password']).toBeUndefined();
    expect(foreign.stderr).toContain('not a GitHub repository of this session');

    const unknown = await fill(clone, {
      ...env,
      CRM_SESSION_TOKEN: 'crm_nope',
    });
    expect(unknown.values['password']).toBeUndefined();
    expect(unknown.stderr).toContain('Unknown or expired session token');

    const outside = await fill(clone, {});
    expect(outside.values['password']).toBeUndefined();
    expect(outside.stderr).toContain('not running in a session');
  });

  it('stops working when the session token is revoked', async () => {
    app.app.get(SessionCredentials).revoke(SESSION);
    const result = await fill(clone, env);
    expect(result.values['password']).toBeUndefined();
  });

  it('answers only for github.com over https', async () => {
    const response = await fetch(
      `http://127.0.0.1:${app.port}/api/git/credentials`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env['CRM_SESSION_TOKEN']}`,
        },
        body: JSON.stringify({
          protocol: 'https',
          host: 'evil.example',
          path: 'alice/app',
        }),
      },
    );
    expect(response.status).toBe(404);
  });
});
