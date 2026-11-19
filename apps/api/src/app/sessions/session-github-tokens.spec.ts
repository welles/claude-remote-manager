import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Authenticator } from '../auth/authenticator';
import type { ProcessIsolation } from '../common/process-isolation';
import { GitService } from '../git/git.service';
import { git } from '../git/testing/git-fixtures';
import { GitHubAppCredentials } from '../github/github-app-credentials';
import { GITHUB_FETCH } from '../github/github-http';
import { FakeGitHub, type FakeRepository } from '../github/testing/fake-github';
import { RepositoryRepository } from '../repositories/repository.repository';
import { startTestApp, type TestApp } from '../testing/test-app';
import {
  GITHUB_HELPER_SCRIPT,
  githubHelperCommand,
} from './session-agent-support';
import { GH_PERMISSIONS } from './session-github-tokens.service';
import { SessionGitHubTokensService } from './session-github-tokens.service';
import { SessionRepository } from './session.repository';
import { SessionTokens } from './session-tokens';

const SESSION = '5b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
const OTHER = '6c3d2e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f';
const SESSION_UID = 64_001;
const REPO_APP = 'a1b2c3d4-0000-4000-8000-000000000001';
const REPO_LIB = 'a1b2c3d4-0000-4000-8000-000000000002';
const REPO_OTHER = 'a1b2c3d4-0000-4000-8000-000000000003';

interface Result {
  stdout: string;
  stderr: string;
  values: Record<string, string>;
}

function baseEnv(env: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...env,
  };
}

/** Runs `git credential fill` in `cwd` like git does before a request. */
function fill(
  cwd: string,
  env: Record<string, string>,
  path = 'alice/app.git',
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['credential', 'fill'],
      { cwd, env: baseEnv(env) },
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

/** Runs the helper's `gh-token` mode like the wrapper docker/gh. */
function ghToken(
  cwd: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const [node, script] = githubHelperCommand()
    .slice(1)
    .split(' ')
    .map((part) => part.replace(/^'|'$/g, ''));
  return new Promise((resolve) => {
    execFile(
      node,
      [script, 'gh-token'],
      { cwd, env: baseEnv(env) },
      (error, stdout, stderr) =>
        resolve({
          stdout,
          stderr,
          code: error ? Number(error.code ?? 1) : 0,
        }),
    );
  });
}

describe('GitHub tokens for session processes', () => {
  let app: TestApp;
  let github: FakeGitHub;
  let repoApp: FakeRepository;
  let repoLib: FakeRepository;
  let clone: string;
  let env: Record<string, string>;
  let peerUid: number | null;

  beforeEach(async () => {
    peerUid = SESSION_UID;
    github = new FakeGitHub();
    const alice = github.addInstallation('alice');
    const bob = github.addInstallation('bob');
    repoApp = github.addRepository(alice, 'app');
    repoLib = github.addRepository(bob, 'lib');
    const repoOther = github.addRepository(alice, 'other');
    const isolation: ProcessIsolation = {
      mode: 'separate-users',
      sessionUser: {
        name: 'claude',
        uid: SESSION_UID,
        gid: SESSION_UID,
        home: '/home/claude',
      },
    };
    app = await startTestApp(
      {},
      {
        configure: (builder) =>
          builder
            .overrideProvider(GITHUB_FETCH)
            .useValue(github.fetch)
            .overrideProvider(GitHubAppCredentials)
            .useValue(github.credentials)
            .overrideProvider(Authenticator)
            .useValue(
              new Authenticator({ mode: 'none' }, isolation, null, () =>
                peerUid === null ? null : { uid: peerUid, inode: 1 },
              ),
            ),
      },
    );
    const repositories = app.app.get(RepositoryRepository);
    const sessions = app.app.get(SessionRepository);
    for (const [id, owner, repository, installation] of [
      [REPO_APP, 'alice', repoApp, alice],
      [REPO_LIB, 'bob', repoLib, bob],
      [REPO_OTHER, 'alice', repoOther, alice],
    ] as const) {
      repositories.create({
        id,
        owner,
        name: repository.name,
        cloneUrl: `https://github.com/${owner}/${repository.name}.git`,
        localPath: join(app.dir, 'repos', owner, repository.name),
        setupScript: null,
        githubRepositoryId: repository.id,
        githubInstallationId: installation.id,
      });
    }
    clone = join(app.dir, 'sessions', 's', 'alice', 'app');
    const libClone = join(app.dir, 'sessions', 's', 'bob', 'lib');
    for (const path of [clone, libClone]) {
      await mkdir(path, { recursive: true });
      await git(path, 'init', '--quiet', '--initial-branch=claude/s');
    }
    await git(
      clone,
      'remote',
      'add',
      'origin',
      'https://github.com/alice/app.git',
    );
    await git(
      libClone,
      'remote',
      'add',
      'origin',
      'git@github.com:bob/lib.git',
    );
    const directory = (path: string, repositoryId: string) => ({
      path,
      kind: 'clone' as const,
      repositoryId,
      branch: 'claude/s',
      baseBranch: 'main',
      state: 'ready' as const,
      setupStatus: 'none' as const,
    });
    const session = (id: string, directories: ReturnType<typeof directory>[]) =>
      sessions.create({
        id,
        title: null,
        model: null,
        permissionMode: 'default',
        status: 'waiting',
        slug: id.slice(0, 8),
        pendingMessage: null,
        directories,
      });
    session(SESSION, [
      directory(clone, REPO_APP),
      directory(libClone, REPO_LIB),
    ]);
    session(OTHER, [
      directory(join(app.dir, 'sessions', 'o', 'alice', 'other'), REPO_OTHER),
    ]);
    env = {
      CRM_API_URL: `http://127.0.0.1:${app.port}`,
      CRM_SESSION_TOKEN: app.app.get(SessionTokens).issue(SESSION),
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: `${githubHelperCommand()} git-credential`,
      GIT_CONFIG_KEY_1: 'credential.https://github.com.useHttpPath',
      GIT_CONFIG_VALUE_1: 'true',
    };
  });
  afterEach(() => app.close());

  const minted = (token: string | undefined) =>
    github.tokens.find((entry) => entry.token === token);

  it('gives git a write token for exactly the remote’s repository', async () => {
    const result = await fill(clone, env);
    expect(result.values['username']).toBe('x-access-token');
    expect(minted(result.values['password'])).toMatchObject({
      repositoryIds: [repoApp.id],
      permissions: { contents: 'write' },
    });
    expect(Number(result.values['password_expiry_utc'])).toBeGreaterThan(
      Date.now() / 1000,
    );
    // Reused for the next request.
    const again = await fill(clone, env);
    expect(again.values['password']).toBe(result.values['password']);
  });

  it('adds workflows: write when the session branch changes workflow files', async () => {
    await mkdir(join(clone, '.github', 'workflows'), { recursive: true });
    await writeFile(
      join(clone, '.github', 'workflows', 'ci.yml'),
      'on: push\n',
    );
    await git(clone, 'add', '.');
    await git(
      clone,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--quiet',
      '-m',
      'ci',
    );
    const result = await fill(clone, env);
    expect(minted(result.values['password'])?.permissions).toEqual({
      contents: 'write',
      workflows: 'write',
    });
  });

  it('refuses repositories of other sessions, unknown tokens and other hosts', async () => {
    const foreign = await fill(clone, env, 'alice/other.git');
    expect(foreign.values['password']).toBeUndefined();
    expect(foreign.stderr).toContain('not a GitHub repository of this session');

    const unknown = await fill(clone, {
      ...env,
      CRM_SESSION_TOKEN: 'crm_nope',
    });
    expect(unknown.values['password']).toBeUndefined();
    expect(unknown.stderr).toContain('Unknown or expired session token');

    const outside = await fill(clone, { ...env, CRM_SESSION_TOKEN: '' });
    expect(outside.values['password']).toBeUndefined();
    expect(outside.stderr).toContain('not running in a session');

    const response = await fetch(
      `http://127.0.0.1:${app.port}/api/session-tokens/git`,
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

  it('answers only session processes', async () => {
    peerUid = null;
    const result = await fill(clone, env);
    expect(result.values['password']).toBeUndefined();
    expect(result.stderr).toContain('Only processes of sessions');
  });

  it('revokes the tokens when the session’s process ends', async () => {
    const result = await fill(clone, env);
    app.app.get(SessionGitHubTokensService).release(SESSION);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(minted(result.values['password'])?.revoked).toBe(true);
    const after = await fill(clone, env);
    expect(after.values['password']).toBeUndefined();
  });

  it('gives gh a read-only token for the repositories of the working directory’s installation', async () => {
    const fromApp = await ghToken(clone, env);
    expect(fromApp.code).toBe(0);
    expect(minted(fromApp.stdout)).toMatchObject({
      repositoryIds: [repoApp.id],
      permissions: GH_PERMISSIONS,
    });

    const fromLib = await ghToken(
      join(app.dir, 'sessions', 's', 'bob', 'lib'),
      env,
    );
    expect(minted(fromLib.stdout)?.repositoryIds).toEqual([repoLib.id]);
  });

  it('gives gh no token outside a session', async () => {
    const result = await ghToken(clone, { ...env, CRM_SESSION_TOKEN: '' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no GitHub token');
  });

  it('revokes also tokens replaced after the reuse window', async () => {
    const service = app.app.get(SessionGitHubTokensService);
    let now = Date.now();
    service.now = () => now;
    const first = await fill(clone, env);
    now += 11 * 60_000;
    const second = await fill(clone, env);
    expect(second.values['password']).not.toBe(first.values['password']);
    service.release(SESSION);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(minted(first.values['password'])?.revoked).toBe(true);
    expect(minted(second.values['password'])?.revoked).toBe(true);
  });

  it('hands out nothing when the process ends while the request waits', async () => {
    const service = app.app.get(SessionGitHubTokensService);
    const git = app.app.get(GitService);
    const original = git.localBranchCommit.bind(git);
    jest.spyOn(git, 'localBranchCommit').mockImplementation(async (...args) => {
      service.release(SESSION);
      return original(...args);
    });
    const result = await fill(clone, env);
    expect(result.values['password']).toBeUndefined();
    expect(github.tokens).toHaveLength(0);
  });

  it('ships the helper script', () => {
    expect(githubHelperCommand()).toContain(GITHUB_HELPER_SCRIPT);
  });
});
