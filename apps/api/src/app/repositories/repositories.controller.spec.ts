import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  RepositoryBranchesResponse,
  RepositoryDto,
  RepositoryListResponse,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { GitService } from '../git/git.service';
import { createOrigin, git, gitSandbox } from '../git/testing/git-fixtures';
import { waitFor } from '../sessions/testing/fake-agent';
import {
  postJson,
  rawRequest,
  startTestApp,
  type TestApp,
} from '../testing/test-app';

describe('repositories REST API', () => {
  let sandbox: ReturnType<typeof gitSandbox>;
  let testApp: TestApp;
  let origin: string;

  beforeEach(async () => {
    sandbox = gitSandbox('crm-repos-');
    origin = join(sandbox.dir, 'remotes', 'acme', 'tool.git');
    await createOrigin(origin);
    await git(origin, 'branch', 'release');
    testApp = await startTestApp();
  });

  afterEach(async () => {
    await testApp.close();
    sandbox.cleanup();
  });

  const get = async <T>(path: string) => {
    const response = await rawRequest(testApp.port, 'GET', path);
    return { status: response.status, body: response.json<T>() };
  };
  const patch = (path: string, body: unknown) =>
    rawRequest(
      testApp.port,
      'PATCH',
      path,
      { 'content-type': 'application/json' },
      JSON.stringify(body),
    );

  /** Registers the test repository and waits for the background clone. */
  const register = async (setupScript?: string): Promise<RepositoryDto> => {
    const response = await postJson(testApp.port, '/api/repositories', {
      cloneUrl: origin,
      ...(setupScript ? { setupScript } : {}),
    });
    expect(response.status).toBe(201);
    const created = response.json<RepositoryDto>();
    let current = created;
    for (let i = 0; i < 300 && !current.clonedAt; i++) {
      current = (await get<RepositoryDto>(`/api/repositories/${created.id}`))
        .body;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return current;
  };

  it('registers a repository by clone URL and clones it in the background', async () => {
    const response = await postJson(testApp.port, '/api/repositories', {
      cloneUrl: `${origin}/`,
      setupScript: 'npm ci\r\n',
    });
    expect(response.status).toBe(201);
    const created = response.json<RepositoryDto>();
    expect(created).toMatchObject({
      owner: 'acme',
      name: 'tool',
      fullName: 'acme/tool',
      cloneUrl: origin,
      localPath: join(testApp.config.reposDir, 'acme', 'tool'),
      setupScript: 'npm ci\n',
      worktrees: [],
    });

    let repository = created;
    for (let i = 0; i < 300 && !repository.clonedAt; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      repository = (await get<RepositoryDto>(`/api/repositories/${created.id}`))
        .body;
    }
    expect(repository).toMatchObject({
      defaultBranch: 'main',
      activity: null,
      lastError: null,
      fetchedAt: expect.any(String),
    });
    expect(
      (
        await get<RepositoryBranchesResponse>(
          `/api/repositories/${created.id}/branches`,
        )
      ).body,
    ).toEqual({ defaultBranch: 'main', branches: ['main', 'release'] });
    const list = await get<RepositoryListResponse>('/api/repositories');
    expect(list.body.repositories.map((r) => r.fullName)).toEqual([
      'acme/tool',
    ]);

    const fetch = await postJson(
      testApp.port,
      `/api/repositories/${created.id}/fetch`,
      {},
    );
    expect(fetch.status).toBe(202);
  });

  it('validates registrations and changes', async () => {
    const invalid: [unknown, number, string][] = [
      [{}, 400, 'cloneUrl must be a string'],
      [{ cloneUrl: 'http://example.com/a/b' }, 400, 'Unsupported protocol'],
      [{ cloneUrl: 'https://u:p@example.com/a/b' }, 400, 'credentials'],
      [{ cloneUrl: '--upload-pack=x' }, 400, 'start with "-"'],
      [
        { cloneUrl: origin, setupScript: 5 },
        400,
        'setupScript must be a string',
      ],
      [
        { cloneUrl: origin, setupScript: 'x'.repeat(20_001) },
        400,
        'longer than',
      ],
      [[], 400, 'body must be a JSON object'],
    ];
    for (const [body, status, message] of invalid) {
      const response = await postJson(testApp.port, '/api/repositories', body);
      expect(response.status).toBe(status);
      expect(response.json<{ message: string }>().message).toContain(message);
    }

    const repository = await register();
    const duplicate = await postJson(testApp.port, '/api/repositories', {
      cloneUrl: 'https://github.com/ACME/Tool.git',
    });
    expect(duplicate.status).toBe(409);

    const updated = await patch(`/api/repositories/${repository.id}`, {
      setupScript: 'npm ci',
    });
    expect(updated.status).toBe(200);
    expect(updated.json<RepositoryDto>().setupScript).toBe('npm ci');
    const cleared = await patch(`/api/repositories/${repository.id}`, {
      setupScript: '  ',
    });
    expect(cleared.json<RepositoryDto>().setupScript).toBeNull();
    expect((await patch(`/api/repositories/${repository.id}`, {})).status).toBe(
      400,
    );
    expect(
      (
        await patch('/api/repositories/0b8f6a3e-6f2d-4e1a-8b7c-5d4e3f2a1b0c', {
          setupScript: null,
        })
      ).status,
    ).toBe(404);
    expect((await get('/api/repositories/unknown')).status).toBe(404);
  });

  it('records clone errors', async () => {
    const response = await postJson(testApp.port, '/api/repositories', {
      cloneUrl: join(sandbox.dir, 'missing', 'repo'),
    });
    const id = response.json<RepositoryDto>().id;
    let repository = response.json<RepositoryDto>();
    for (let i = 0; i < 300 && !repository.lastError; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      repository = (await get<RepositoryDto>(`/api/repositories/${id}`)).body;
    }
    expect(repository).toMatchObject({
      clonedAt: null,
      lastError: expect.stringContaining('git fetch failed'),
    });
  });

  it('lists worktrees per repository and marks orphaned and missing ones', async () => {
    const repository = await register();
    const created = await postJson(testApp.port, '/api/sessions', {
      prompt: 'Work',
      repositories: [{ repositoryId: repository.id }],
    });
    expect(created.status).toBe(201);
    const session = created.json<SessionDto>();
    await waitFor(() => testApp.runner.runs.length === 1);
    const sessionPath = join(
      testApp.config.worktreesDir,
      'acme',
      'tool',
      session.slug ?? '',
    );

    // A worktree without session (e.g. left over from a deleted database),
    // and a directory of an unregistered repository.
    const orphan = join(
      testApp.config.worktreesDir,
      'acme',
      'tool',
      'leftover',
    );
    const gitService = new GitService();
    await gitService.addWorktree({
      repoPath: repository.localPath,
      path: orphan,
      branch: 'claude/leftover',
      baseCommit: await git(origin, 'rev-parse', 'main'),
      lockReason: 'test',
    });
    const stray = join(testApp.config.worktreesDir, 'other', 'repo', 'old');
    await mkdir(stray, { recursive: true });

    let list = (await get<RepositoryListResponse>('/api/repositories')).body;
    expect(list.strayDirectories).toEqual([stray]);
    expect(list.repositories[0].worktrees).toEqual([
      {
        path: orphan,
        branch: 'claude/leftover',
        sessionId: null,
        sessionTitle: null,
        orphaned: true,
        missing: false,
      },
      {
        path: sessionPath,
        branch: `claude/${session.slug}`,
        sessionId: session.id,
        sessionTitle: 'Work',
        orphaned: false,
        missing: false,
      },
    ]);

    await rename(sessionPath, `${sessionPath}-moved`);
    list = (await get<RepositoryListResponse>('/api/repositories')).body;
    expect(
      list.repositories[0].worktrees.find((w) => w.path === sessionPath),
    ).toMatchObject({ orphaned: false, missing: true });
  });
});
