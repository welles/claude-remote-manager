import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { CreateSessionRequest } from '@claude-remote-manager/shared-types';
import { commitFile, git } from '../git/testing/git-fixtures';
import { SessionEventRepository } from '../sessions/session-event.repository';
import {
  ENDED_WHILE_PREPARING,
  PREPARATION_INTERRUPTED,
} from '../sessions/sessions.service';
import { waitFor } from '../sessions/testing/fake-agent';
import { WorkspaceHarness } from './testing/workspace-harness';

describe('session preparation', () => {
  let harness: WorkspaceHarness;

  beforeEach(async () => {
    harness = new WorkspaceHarness();
    await harness.start();
  });

  afterEach(() => harness.close());

  const create = (request: Partial<CreateSessionRequest>) =>
    harness.service.create({
      prompt: 'Do the work',
      model: 'haiku',
      ...request,
    });

  const head = (path: string) => git(path, 'rev-parse', 'HEAD');
  const branchOf = (path: string) =>
    git(path, 'symbolic-ref', '--short', 'HEAD');

  it('creates a worktree per repository; the first is the working directory', async () => {
    const main = await harness.addRepository('acme', 'app');
    const library = await harness.addRepository('acme', 'lib');
    await git(library.origin, 'checkout', '--quiet', '-b', 'release');
    const release = await commitFile(library.origin, 'release.txt', 'r');

    const session = await create({
      title: 'Add the export',
      repositories: [
        { repositoryId: main.id },
        { repositoryId: library.id, baseBranch: 'release' },
      ],
    });
    expect(session.status).toBe('preparing');
    expect(session.slug).toMatch(/^add-the-export-[a-z0-9]{6}$/);
    expect(harness.runner.runs).toHaveLength(0);
    await harness.prepared(session.id);

    const mainPath = join(
      harness.config.worktreesDir,
      'acme',
      'app',
      session.slug ?? '',
    );
    const libPath = join(
      harness.config.worktreesDir,
      'acme',
      'lib',
      session.slug ?? '',
    );
    const dto = harness.service.get(session.id);
    expect(dto.status).toBe('running');
    expect(dto.cwd).toBe(mainPath);
    expect(dto.additionalDirectories).toEqual([libPath]);
    expect(dto.directories).toEqual([
      {
        role: 'main',
        kind: 'worktree',
        path: mainPath,
        state: 'ready',
        repository: { id: main.id, fullName: 'acme/app' },
        projectName: null,
        branch: `claude/${session.slug}`,
        baseBranch: 'main',
        baseCommit: await git(main.origin, 'rev-parse', 'main'),
        setupStatus: 'none',
      },
      expect.objectContaining({
        role: 'additional',
        path: libPath,
        branch: `claude/${session.slug}`,
        baseBranch: 'release',
        baseCommit: release,
      }),
    ]);
    expect(await branchOf(mainPath)).toBe(`claude/${session.slug}`);
    expect(await head(libPath)).toBe(release);
    expect(harness.runner.last.options).toMatchObject({
      cwd: mainPath,
      additionalDirectories: [libPath],
    });
    expect(harness.runner.last.sent).toEqual([
      { id: expect.any(String), text: 'Do the work' },
    ]);
    const steps = harness
      .eventsOfType(session.id, 'prepare.progress')
      .map((event) => `${event.step}:${event.state}:${event.target ?? ''}`);
    expect(steps).toEqual(
      expect.arrayContaining([
        'fetch:started:acme/app',
        'fetch:succeeded:acme/app',
        'worktree:succeeded:acme/app',
        'worktree:succeeded:acme/lib',
      ]),
    );
    expect(steps.at(-1)).toBe('done:succeeded:');
    expect(harness.sessions.require(session.id).pendingMessage).toBeNull();
  });

  it('starts a new project with git init, plus further repositories', async () => {
    const library = await harness.addRepository('acme', 'lib');

    const session = await create({
      newProject: { name: 'new-app' },
      repositories: [{ repositoryId: library.id }],
    });
    await harness.prepared(session.id);

    const projectPath = join(harness.config.projectsDir, 'new-app');
    const dto = harness.service.get(session.id);
    expect(dto.status).toBe('running');
    expect(dto.directories.map((d) => [d.role, d.kind, d.projectName])).toEqual(
      [
        ['main', 'project', 'new-app'],
        ['additional', 'worktree', null],
      ],
    );
    expect(harness.runner.last.options.cwd).toBe(projectPath);
    expect(await branchOf(projectPath)).toBe('main');
    await expect(git(projectPath, 'remote')).resolves.toBe('');

    await expect(create({ newProject: { name: 'new-app' } })).rejects.toThrow(
      ConflictException,
    );
  });

  it('lets many sessions work in the same repository without touching each other', async () => {
    const repo = await harness.addRepository(
      'acme',
      'app',
      'echo "$CRM_SESSION_SLUG" > owner.txt',
    );

    const sessions = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        create({
          title: 'Same issue',
          prompt: `Issue ${index}`,
          repositories: [{ repositoryId: repo.id }],
        }),
      ),
    );
    await Promise.all(sessions.map((session) => harness.prepared(session.id)));

    const slugs = sessions.map((session) => session.slug ?? '');
    expect(new Set(slugs).size).toBe(5);
    const paths = slugs.map((slug) =>
      join(harness.config.worktreesDir, 'acme', 'app', slug),
    );
    for (const [index, path] of paths.entries()) {
      expect(harness.service.get(sessions[index].id).status).toBe('running');
      expect(await branchOf(path)).toBe(`claude/${slugs[index]}`);
      // The setup script ran in the session's own worktree only.
      expect(await readFile(join(path, 'owner.txt'), 'utf8')).toBe(
        `${slugs[index]}\n`,
      );
    }
    expect((await harness.git.listWorktrees(repo.localPath)).length).toBe(5);

    // One session commits; a new remote commit arrives; a sixth session
    // starts (fetching again); the first session's worktree is removed.
    const before = await head(paths[1]);
    await commitFile(paths[0], 'work.txt', 'work');
    const remote = await commitFile(repo.origin, 'remote.txt', 'remote');
    const sixth = await create({ repositories: [{ repositoryId: repo.id }] });
    await harness.prepared(sixth.id);
    await harness.git.removeWorktree(repo.localPath, paths[0], { force: true });

    expect(harness.service.get(sixth.id).directories[0].baseCommit).toBe(
      remote,
    );
    for (const path of paths.slice(1)) {
      expect(await head(path)).toBe(before);
      expect(await git(path, 'status', '--porcelain')).toBe('?? owner.txt');
    }
  });

  it('removes the other worktrees again when one cannot be created', async () => {
    const first = await harness.addRepository('acme', 'one');
    const second = await harness.addRepository('acme', 'two');
    const third = await harness.addRepository('acme', 'three');

    const session = await create({
      repositories: [
        { repositoryId: first.id },
        { repositoryId: second.id, baseBranch: 'missing' },
        { repositoryId: third.id },
      ],
    });
    await harness.prepared(session.id);

    const dto = harness.service.get(session.id);
    expect(dto.status).toBe('failed');
    expect(dto.lastError).toBe(
      "Could not create the worktree of acme/two: Branch missing does not exist. The session's other directories were removed again.",
    );
    expect(dto.directories.map((d) => d.state)).toEqual([
      'removed',
      'failed',
      'removed',
    ]);
    for (const repo of [first, third]) {
      expect(await harness.git.listWorktrees(repo.localPath)).toEqual([]);
      expect(
        await harness.git.branchExists(
          repo.localPath,
          `claude/${session.slug}`,
        ),
      ).toBe(false);
    }
    expect(harness.runner.runs).toHaveLength(0);
    expect(
      harness
        .eventsOfType(session.id, 'prepare.progress')
        .filter(
          (event) => event.step === 'rollback' && event.state === 'succeeded',
        ),
    ).toHaveLength(2);
    expect(harness.eventsOfType(session.id, 'error').at(-1)?.message).toBe(
      dto.lastError,
    );
    await expect(
      harness.service.send(session.id, { text: 'Try again' }),
    ).rejects.toThrow('not available');
    const listed = await harness.repositories.get(first.id);
    expect(listed.worktrees).toEqual([]);
  });

  it('reports a repository that cannot be cloned', async () => {
    const broken = harness.repositoryRecords.create({
      id: '0b8f6a3e-6f2d-4e1a-8b7c-5d4e3f2a1b0c',
      owner: 'acme',
      name: 'gone',
      cloneUrl: join(harness.dir, 'does-not-exist'),
      localPath: join(harness.config.reposDir, 'acme', 'gone'),
      setupScript: null,
    });

    const session = await create({
      repositories: [{ repositoryId: broken.id }],
    });
    await harness.prepared(session.id);

    expect(harness.service.get(session.id)).toMatchObject({
      status: 'failed',
      lastError: expect.stringMatching(
        /^Could not update acme\/gone: git fetch failed/,
      ),
    });
    expect(harness.repositoryRecords.require(broken.id).lastError).toMatch(
      /git fetch failed/,
    );
  });

  it('runs setup scripts after the worktrees, streams and stores their output', async () => {
    const ok = await harness.addRepository(
      'acme',
      'ok',
      'echo "setting up $CRM_REPOSITORY"; test -d .git || test -f .git',
    );
    const broken = await harness.addRepository(
      'acme',
      'broken',
      'echo "missing tool" >&2\nexit 3',
    );

    const session = await create({
      repositories: [{ repositoryId: ok.id }, { repositoryId: broken.id }],
    });
    await harness.prepared(session.id);

    const dto = harness.service.get(session.id);
    // A failing setup script is reported, the session goes on.
    expect(dto.status).toBe('running');
    expect(harness.runner.runs).toHaveLength(1);
    expect(dto.directories.map((d) => d.setupStatus)).toEqual([
      'succeeded',
      'failed',
    ]);
    const results = harness.eventsOfType(session.id, 'setup.result');
    expect(
      results.map((r) => `${r.repository}:${r.state}:${r.exitCode}`),
    ).toEqual([
      'acme/ok:started:null',
      'acme/ok:succeeded:0',
      'acme/broken:started:null',
      'acme/broken:failed:3',
    ]);
    const output = harness.eventsOfType(session.id, 'setup.output');
    expect(output.map((o) => `${o.repository}:${o.text}`)).toEqual([
      'acme/ok:setting up acme/ok\n',
      'acme/broken:missing tool\n',
    ]);
    // Setup ran after both worktrees existed.
    const types = harness
      .eventsOf(session.id)
      .map((event) =>
        event.type === 'prepare.progress'
          ? `${event.step}:${event.state}`
          : event.type,
      );
    expect(types.lastIndexOf('worktree:succeeded')).toBeLessThan(
      types.indexOf('setup.result'),
    );
    // Stored like the other app events.
    const stored = new SessionEventRepository(harness.db)
      .list(session.id)
      .map((item) => item.event.type);
    expect(stored).toEqual(
      expect.arrayContaining([
        'prepare.progress',
        'setup.output',
        'setup.result',
      ]),
    );
  });

  it('refuses messages while preparing; ending stops the setup and keeps the message back', async () => {
    const repo = await harness.addRepository('acme', 'slow', 'sleep 30');
    const session = await create({ repositories: [{ repositoryId: repo.id }] });
    await waitFor(
      () => harness.eventsOfType(session.id, 'setup.result').length > 0,
    );

    await expect(
      harness.service.send(session.id, { text: 'More' }),
    ).rejects.toThrow('still being prepared');
    await expect(harness.service.interrupt(session.id)).rejects.toThrow(
      'still being prepared',
    );
    const started = Date.now();
    const ended = await harness.service.end(session.id);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(ended.status).toBe('finished');
    expect(ended.directories[0]).toMatchObject({
      state: 'ready',
      setupStatus: 'failed',
    });
    expect(
      harness.eventsOfType(session.id, 'setup.result').at(-1),
    ).toMatchObject({
      state: 'failed',
      message: 'Stopped because the session was ended',
    });
    expect(harness.eventsOfType(session.id, 'notice').at(-1)?.text).toBe(
      ENDED_WHILE_PREPARING,
    );
    expect(harness.runner.runs).toHaveLength(0);

    // The worktree is there; a new message starts Claude in it.
    await harness.service.send(session.id, { text: 'Start now' });
    await waitFor(() => harness.runner.runs.length === 1);
    expect(harness.runner.last.sent[0].text).toBe('Start now');
    expect(harness.runner.last.options.cwd).toBe(ended.cwd);
  });

  it('rolls back a preparation that a server stop cut off', async () => {
    const repo = await harness.addRepository('acme', 'slow', 'sleep 30');
    const session = await create({ repositories: [{ repositoryId: repo.id }] });
    await waitFor(
      () => harness.eventsOfType(session.id, 'setup.result').length > 0,
    );
    const path = harness.service.get(session.id).cwd;
    expect(existsSync(path)).toBe(true);

    await harness.service.onModuleDestroy();
    expect(harness.sessions.require(session.id).status).toBe('preparing');
    await harness.start();

    const dto = harness.service.get(session.id);
    expect(dto).toMatchObject({
      status: 'failed',
      lastError: PREPARATION_INTERRUPTED,
    });
    expect(dto.directories[0].state).toBe('removed');
    expect(existsSync(path)).toBe(false);
    expect(
      await harness.git.branchExists(repo.localPath, `claude/${session.slug}`),
    ).toBe(false);
    // The first message is still shown, followed by what happened.
    const history = await harness.service.subscribe(session.id);
    expect(history.events[0]).toMatchObject({
      type: 'user.message',
      text: 'Do the work',
    });
    expect(history.events.at(-1)).toMatchObject({
      type: 'error',
      message: PREPARATION_INTERRUPTED,
    });
    harness.service.unsubscribe(session.id);
  });

  it('validates repositories and projects', async () => {
    const repo = await harness.addRepository('acme', 'app');
    const invalid: [unknown, string][] = [
      [{}, 'Choose a main repository or a new project'],
      [{ repositories: [] }, 'Choose a main repository'],
      [{ repositories: 'x' }, 'repositories must be an array'],
      [{ repositories: [{ repositoryId: 'nope' }] }, 'must be a UUID'],
      [{ repositories: [5] }, 'must be a JSON object'],
      [
        {
          repositories: [{ repositoryId: repo.id }, { repositoryId: repo.id }],
        },
        'only once',
      ],
      [
        {
          repositories: [
            { repositoryId: '0b8f6a3e-6f2d-4e1a-8b7c-5d4e3f2a1b0c' },
          ],
        },
        'not found',
      ],
      [
        {
          repositories: [
            { repositoryId: repo.id, baseBranch: '--upload-pack=x' },
          ],
        },
        'not a valid branch name',
      ],
      [
        { repositories: [{ repositoryId: repo.id, baseBranch: 5 }] },
        'baseBranch must be a string',
      ],
      [
        {
          repositories: Array.from({ length: 11 }, () => ({
            repositoryId: repo.id,
          })),
        },
        'at most 10',
      ],
      [{ newProject: { name: '../escape' } }, 'newProject.name'],
      [{ newProject: { name: '.hidden' } }, 'newProject.name'],
      [{ newProject: 'app' }, 'newProject must be a JSON object'],
    ];
    for (const [request, message] of invalid) {
      await expect(
        create(request as Partial<CreateSessionRequest>),
      ).rejects.toThrow(message);
      await expect(
        create(request as Partial<CreateSessionRequest>),
      ).rejects.toThrow(BadRequestException);
    }
    expect(harness.service.list()).toEqual([]);
  });
});
