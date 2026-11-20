import { existsSync } from 'node:fs';
import { cloneRule, WorkspaceEntries } from './workspace-entries';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type {
  CreateSessionRequest,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { commitFile, git } from '../git/testing/git-fixtures';
import { SessionEventRepository } from '../sessions/session-event.repository';
import {
  ENDED_WHILE_PREPARING,
  PREPARATION_INTERRUPTED,
  setupFailedNotice,
} from '../sessions/sessions.service';
import { waitFor } from '../sessions/testing/fake-agent';
import { ageInWords } from './session-workspace.service';
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

  const clonePath = (session: SessionDto, owner: string, name: string) =>
    join(harness.config.sessionsDir, session.slug ?? '', owner, name);
  const head = (path: string) => git(path, 'rev-parse', 'HEAD');
  const branchOf = (path: string) =>
    git(path, 'symbolic-ref', '--short', 'HEAD');

  it('clones each repository for the session; the first is the working directory', async () => {
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
    expect(session).toMatchObject({
      status: 'preparing',
      pendingMessage: 'Do the work',
    });
    expect(session.slug).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9]{6}$/);
    expect(harness.runner.runs).toHaveLength(0);
    await harness.prepared(session.id);

    const mainPath = clonePath(session, 'acme', 'app');
    const libPath = clonePath(session, 'acme', 'lib');
    const dto = harness.service.get(session.id);
    expect(dto).toMatchObject({
      status: 'running',
      pendingMessage: null,
      cwd: mainPath,
      additionalDirectories: [libPath],
    });
    expect(dto.directories).toEqual([
      {
        role: 'main',
        kind: 'clone',
        path: mainPath,
        state: 'ready',
        repository: {
          id: main.id,
          fullName: 'acme/app',
          local: false,
          github: false,
        },
        branch: `claude/${session.slug}`,
        baseBranch: 'main',
        baseCommit: await git(main.origin, 'rev-parse', 'main'),
        setupStatus: 'none',
        pushedCommit: null,
        pushedAt: null,
        addition: null,
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
    expect(await git(mainPath, 'remote', 'get-url', 'origin')).toBe(
      main.origin,
    );
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
        'clone:succeeded:acme/app',
        'clone:succeeded:acme/lib',
      ]),
    );
    expect(steps.at(-1)).toBe('done:succeeded:');
  });

  it('creates a local project; later sessions get their own clones of it', async () => {
    const library = await harness.addRepository('acme', 'lib');

    const first = await create({
      newProject: { name: 'new-app' },
      repositories: [{ repositoryId: library.id }],
    });
    await harness.prepared(first.id);

    const project = harness.service.get(first.id).directories[0];
    expect(project).toMatchObject({
      role: 'main',
      kind: 'clone',
      repository: { fullName: 'local/new-app', local: true },
      baseBranch: 'main',
      baseCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    const mirror = join(harness.config.reposDir, 'local', 'new-app');
    expect(await head(project.path)).toBe(project.baseCommit);
    expect(
      await git(project.path, 'log', '--format=%an <%ae>|%s', 'HEAD'),
    ).toBe('Test Author <author@example.com>|Initial commit');
    expect(await git(project.path, 'remote', 'get-url', 'origin')).toBe(mirror);
    expect(await branchOf(project.path)).toBe(`claude/${first.slug}`);
    expect(harness.runner.last.options.cwd).toBe(project.path);
    await commitFile(project.path, 'app.txt', 'first');

    // The project is a repository like the others; it is taken by name.
    await expect(create({ newProject: { name: 'new-app' } })).rejects.toThrow(
      ConflictException,
    );
    const second = await create({
      repositories: [{ repositoryId: project.repository?.id ?? '' }],
    });
    await harness.prepared(second.id);
    const secondPath = harness.service.get(second.id).cwd;
    expect(secondPath).toBe(clonePath(second, 'local', 'new-app'));
    expect(await branchOf(secondPath)).toBe(`claude/${second.slug}`);
    // The first session's work is not integrated into main yet.
    expect(existsSync(join(secondPath, 'app.txt'))).toBe(false);
    const listed = await harness.repositories.get(project.repository?.id ?? '');
    expect(listed).toMatchObject({ local: true, cloneUrl: null });
    expect(listed.clones.map((clone) => clone.sessionId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it('applies the commit identity to clones, a changed one at startup', async () => {
    const repository = await harness.addRepository('acme', 'app');
    const session = await create({
      repositories: [{ repositoryId: repository.id }],
    });
    await harness.prepared(session.id);
    const path = harness.service.get(session.id).cwd;
    await commitFile(path, 'a.txt', 'a');
    expect(await git(path, 'log', '-1', '--format=%an <%ae>')).toBe(
      'Test Author <author@example.com>',
    );

    // The environment changed, then the API restarts.
    harness.config.gitIdentity = {
      name: 'Grace Hopper',
      email: 'grace@example.com',
    };
    await harness.start();
    expect(await git(path, 'config', 'user.name')).toBe('Grace Hopper');
    expect(await harness.workspaces.applyIdentity()).toBe(0);
    await commitFile(path, 'b.txt', 'b');
    expect(await git(path, 'log', '-1', '--format=%an <%ae>')).toBe(
      'Grace Hopper <grace@example.com>',
    );
  });

  it('starts no session with repositories without a commit identity', async () => {
    const repository = await harness.addRepository('acme', 'app');
    harness.config.gitIdentity = null;
    await expect(
      create({ repositories: [{ repositoryId: repository.id }] }),
    ).rejects.toThrow('CRM_GIT_AUTHOR_NAME');
    await expect(create({ newProject: { name: 'p' } })).rejects.toThrow(
      ConflictException,
    );
    // Scratch sessions have no git.
    await expect(create({ scratch: true })).resolves.toMatchObject({
      status: 'preparing',
    });
  });

  it('gives a scratch session an empty directory of its own', async () => {
    const one = await create({ scratch: true, title: 'Quick question' });
    const two = await create({ scratch: true, title: 'Quick question' });
    await Promise.all([harness.prepared(one.id), harness.prepared(two.id)]);

    const dto = harness.service.get(one.id);
    expect(dto.directories).toEqual([
      expect.objectContaining({
        role: 'main',
        kind: 'scratch',
        path: join(harness.config.scratchDir, one.slug ?? ''),
        state: 'ready',
        repository: null,
        branch: null,
      }),
    ]);
    expect(dto.status).toBe('running');
    expect(harness.service.get(two.id).cwd).not.toBe(dto.cwd);
    expect(existsSync(join(dto.cwd, '.git'))).toBe(false);
    await expect(
      create({ scratch: true, newProject: { name: 'x' } }),
    ).rejects.toThrow('no repositories or project');
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
    const paths = sessions.map((session) => clonePath(session, 'acme', 'app'));
    for (const [index, path] of paths.entries()) {
      expect(harness.service.get(sessions[index].id).status).toBe('running');
      expect(await branchOf(path)).toBe(`claude/${slugs[index]}`);
      expect(await readFile(join(path, 'owner.txt'), 'utf8')).toBe(
        `${slugs[index]}\n`,
      );
    }

    // One session commits and stashes; a remote commit arrives; a sixth
    // session starts (fetching again); the first session's clone is removed.
    const before = await head(paths[1]);
    await commitFile(paths[0], 'work.txt', 'work');
    await git(paths[0], 'stash', 'push', '--include-untracked', '--quiet');
    const remote = await commitFile(repo.origin, 'remote.txt', 'remote');
    const sixth = await create({ repositories: [{ repositoryId: repo.id }] });
    await harness.prepared(sixth.id);
    await new WorkspaceEntries(harness.config).remove(
      paths[0],
      cloneRule(slugs[0]),
    );
    expect(existsSync(paths[0])).toBe(false);

    expect(harness.service.get(sixth.id).directories[0].baseCommit).toBe(
      remote,
    );
    for (const path of paths.slice(1)) {
      expect(await head(path)).toBe(before);
      expect(await git(path, 'status', '--porcelain')).toBe('?? owner.txt');
      expect(await git(path, 'stash', 'list')).toBe('');
    }
    // Several clones and setup scripts: slow on a busy machine.
  }, 20_000);

  it('removes the other clones again when one cannot be created', async () => {
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
      "Could not create the clone of acme/two: Branch missing does not exist. The session's other directories were removed again.",
    );
    expect(dto.directories.map((d) => d.state)).toEqual([
      'removed',
      'failed',
      'removed',
    ]);
    expect(
      existsSync(join(harness.config.sessionsDir, session.slug ?? '')),
    ).toBe(false);
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
    expect((await harness.repositories.get(first.id)).clones).toEqual([]);
  });

  it('fails a repository that was never cloned and cannot be', async () => {
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

  it('starts from the last fetched state when the remote cannot be reached', async () => {
    const repo = await harness.addRepository('acme', 'app');
    await harness.repositories.update(repo.id);
    harness.repositoryRecords.update(repo.id, {
      fetchedAt: new Date(Date.now() - 3 * 3_600_000),
    });
    await rename(repo.origin, `${repo.origin}-offline`);

    const session = await create({ repositories: [{ repositoryId: repo.id }] });
    await harness.prepared(session.id);

    expect(harness.service.get(session.id).status).toBe('running');
    expect(harness.eventsOfType(session.id, 'notice').at(-1)?.text).toBe(
      'acme/app could not be fetched; the session starts from the state fetched 3 hours ago.',
    );
    expect(
      harness
        .eventsOfType(session.id, 'prepare.progress')
        .find((event) => event.step === 'fetch' && event.state === 'failed')
        ?.message,
    ).toMatch(/^Could not update acme\/app: /);
  });

  it('holds the first message back when a setup script fails; it can be sent anyway', async () => {
    const ok = await harness.addRepository(
      'acme',
      'ok',
      'echo "setting up $CRM_REPOSITORY"; test -d .git',
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
    expect(dto).toMatchObject({
      status: 'waiting',
      pendingMessage: 'Do the work',
    });
    expect(harness.runner.runs).toHaveLength(0);
    expect(dto.directories.map((d) => d.setupStatus)).toEqual([
      'succeeded',
      'failed',
    ]);
    expect(harness.eventsOfType(session.id, 'notice').at(-1)?.text).toBe(
      setupFailedNotice(['acme/broken']),
    );
    const results = harness.eventsOfType(session.id, 'setup.result');
    expect(
      results.map((r) => `${r.repository}:${r.state}:${r.exitCode}`),
    ).toEqual([
      'acme/ok:started:null',
      'acme/ok:succeeded:0',
      'acme/broken:started:null',
      'acme/broken:failed:3',
    ]);
    expect(
      harness
        .eventsOfType(session.id, 'setup.output')
        .map((o) => `${o.repository}:${o.text}`),
    ).toEqual(['acme/ok:setting up acme/ok\n', 'acme/broken:missing tool\n']);
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
    await expect(
      harness.service.send(session.id, { text: 'Something else' }),
    ).rejects.toThrow('send it anyway');

    // Survives a restart, then the user sends it anyway.
    await harness.service.onModuleDestroy();
    await harness.start();
    expect(harness.service.get(session.id).pendingMessage).toBe('Do the work');
    const sent = await harness.service.sendPending(session.id);
    expect(sent.pendingMessage).toBeNull();
    await waitFor(() => harness.runner.runs.length === 1);
    expect(harness.runner.last.sent[0].text).toBe('Do the work');
    expect(harness.service.get(session.id).status).toBe('running');
    await expect(harness.service.sendPending(session.id)).rejects.toThrow(
      'no first message waiting',
    );
  });

  it('runs failed setup scripts again and then sends the first message', async () => {
    const repo = await harness.addRepository('acme', 'app', 'test -f ready');
    const session = await create({ repositories: [{ repositoryId: repo.id }] });
    await harness.prepared(session.id);
    expect(harness.service.get(session.id).status).toBe('waiting');

    // Still failing: waits again.
    await harness.service.rerunSetup(session.id);
    await harness.prepared(session.id);
    expect(harness.service.get(session.id)).toMatchObject({
      status: 'waiting',
      pendingMessage: 'Do the work',
    });

    harness.repositoryRecords.update(repo.id, { setupScript: 'touch ready' });
    const rerun = await harness.service.rerunSetup(session.id);
    expect(rerun.status).toBe('preparing');
    await harness.prepared(session.id);

    expect(harness.service.get(session.id)).toMatchObject({
      status: 'running',
      pendingMessage: null,
    });
    expect(harness.service.get(session.id).directories[0].setupStatus).toBe(
      'succeeded',
    );
    expect(harness.runner.last.sent[0].text).toBe('Do the work');
    expect(
      harness
        .eventsOfType(session.id, 'setup.result')
        .map((result) => result.state),
    ).toEqual([
      'started',
      'failed',
      'started',
      'failed',
      'started',
      'succeeded',
    ]);
  });

  it('drops the held-back message when the session is ended', async () => {
    const repo = await harness.addRepository('acme', 'app', 'exit 1');
    const session = await create({ repositories: [{ repositoryId: repo.id }] });
    await harness.prepared(session.id);

    const ended = await harness.service.end(session.id);

    expect(ended).toMatchObject({ status: 'finished', pendingMessage: null });
    expect(harness.eventsOfType(session.id, 'notice').at(-1)?.text).toBe(
      ENDED_WHILE_PREPARING,
    );
    await harness.service.send(session.id, { text: 'Go on' });
    await waitFor(() => harness.runner.runs.length === 1);
    expect(harness.runner.last.sent[0].text).toBe('Go on');
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
    expect(ended).toMatchObject({ status: 'finished', pendingMessage: null });
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

  it('validates repositories, projects and scratch', async () => {
    const repo = await harness.addRepository('acme', 'app');
    const invalid: [unknown, string][] = [
      [{}, 'Choose a main repository'],
      [{ repositories: [] }, 'Choose a main repository'],
      [{ scratch: false }, 'Choose a main repository'],
      [{ scratch: 'yes' }, 'scratch must be a boolean'],
      [
        { scratch: true, repositories: [{ repositoryId: repo.id }] },
        'no repositories',
      ],
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
      [{ newProject: { name: '../escape' } }, 'project name'],
      [{ newProject: { name: '.hidden' } }, 'project name'],
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

describe('ageInWords', () => {
  const now = new Date('2026-01-10T12:00:00Z');
  it.each([
    [0, '0 minutes'],
    [60_000, '1 minute'],
    [3 * 3_600_000, '3 hours'],
    [5 * 86_400_000, '5 days'],
  ])('%d ms ago is %s', (ms, words) => {
    expect(ageInWords(new Date(now.getTime() - ms), now)).toBe(words);
  });
});
