import { openDatabase, type AppDatabase } from '../db/database';
import { RepositoryRepository } from '../repositories/repository.repository';
import {
  additionalDirectories,
  SessionRepository,
  workingDirectory,
} from './session.repository';
import { newSessionRecord, plainDirectory } from './testing/records';
import { UsageRepository } from './usage.repository';

const REPO_ID = '7d0a3c2e-1b4f-4e6a-9c8d-2f1e0a9b8c7d';

describe('SessionRepository', () => {
  let db: AppDatabase;
  let repository: SessionRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repository = new SessionRepository(db);
  });

  afterEach(() => db.$client.close());

  const newSession = (id = 'session-1') =>
    newSessionRecord({
      id,
      directories: [
        plainDirectory('/work/main'),
        plainDirectory('/work/second'),
        plainDirectory('/work/third'),
      ],
    });

  it('creates a session with its directories in order', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    const created = repository.create(newSession(), now);

    expect(created).toMatchObject({
      id: 'session-1',
      sdkSessionId: null,
      title: 'Title',
      model: 'haiku',
      permissionMode: 'default',
      status: 'running',
      slug: null,
      pendingMessage: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(created.directories.map((d) => [d.position, d.path])).toEqual([
      [0, '/work/main'],
      [1, '/work/second'],
      [2, '/work/third'],
    ]);
    expect(workingDirectory(created)).toBe('/work/main');
    expect(additionalDirectories(created)).toEqual([
      '/work/second',
      '/work/third',
    ]);
    expect(repository.get('session-1')).toEqual(created);
  });

  it('creates worktree and project directories with their repository and project', () => {
    new RepositoryRepository(db).create({
      id: REPO_ID,
      owner: 'acme',
      name: 'tool',
      cloneUrl: 'https://github.com/acme/tool.git',
      localPath: '/repos/acme/tool',
      setupScript: null,
    });
    const created = repository.create(
      newSessionRecord({
        status: 'preparing',
        slug: 'fix-it-abc123',
        pendingMessage: { id: 'm1', text: 'Fix it' },
        directories: [
          {
            ...plainDirectory('/projects/new-app'),
            state: 'pending',
            newProject: { id: 'p1', name: 'new-app' },
          },
          {
            path: '/worktrees/acme/tool/fix-it-abc123',
            repositoryId: REPO_ID,
            branch: 'claude/fix-it-abc123',
            baseBranch: 'release',
            state: 'pending',
            setupStatus: 'pending',
          },
        ],
      }),
    );

    expect(created.pendingMessage).toEqual({ id: 'm1', text: 'Fix it' });
    expect(created.directories).toEqual([
      expect.objectContaining({
        projectId: 'p1',
        projectName: 'new-app',
        repositoryId: null,
        state: 'pending',
      }),
      expect.objectContaining({
        repositoryId: REPO_ID,
        repositoryName: 'acme/tool',
        branch: 'claude/fix-it-abc123',
        baseBranch: 'release',
        baseCommit: null,
        setupStatus: 'pending',
      }),
    ]);
    expect(repository.slugExists('fix-it-abc123')).toBe(true);
    expect(repository.projectExists('new-app')).toBe(true);
    expect(repository.listByStatus('preparing').map((s) => s.id)).toEqual([
      'session-1',
    ]);

    const later = new Date('2026-01-02T00:00:00Z');
    const updated = repository.updateDirectory(
      'session-1',
      1,
      { state: 'ready', baseCommit: 'abc', setupStatus: 'succeeded' },
      later,
    );
    expect(updated.directories[1]).toMatchObject({
      state: 'ready',
      baseCommit: 'abc',
      setupStatus: 'succeeded',
    });
    expect(updated.updatedAt).toEqual(later);

    // The same branch of a repository cannot belong to two sessions.
    expect(() =>
      repository.create(
        newSessionRecord({
          id: 'session-2',
          directories: [
            {
              path: '/elsewhere',
              repositoryId: REPO_ID,
              branch: 'claude/fix-it-abc123',
              baseBranch: null,
              state: 'pending',
              setupStatus: 'none',
            },
          ],
        }),
      ),
    ).toThrow(/UNIQUE/);
    expect(repository.get('session-2')).toBeUndefined();
  });

  it('returns undefined for unknown sessions', () => {
    expect(repository.get('missing')).toBeUndefined();
    expect(() => repository.require('missing')).toThrow('not found');
  });

  it('refuses sessions without directories', () => {
    expect(() =>
      repository.create(newSessionRecord({ directories: [] })),
    ).toThrow('at least one directory');
  });

  it('lists sessions by last update, newest first', () => {
    repository.create(newSession('a'), new Date('2026-01-01T10:00:00Z'));
    repository.create(newSession('b'), new Date('2026-01-01T11:00:00Z'));
    repository.update(
      'a',
      { status: 'waiting' },
      new Date('2026-01-01T12:00:00Z'),
    );

    const list = repository.list();
    expect(list.map((session) => session.id)).toEqual(['a', 'b']);
    expect(list[1].directories).toHaveLength(3);
  });

  it('updates fields and the update time', () => {
    repository.create(newSession(), new Date('2026-01-01T10:00:00Z'));
    const later = new Date('2026-01-01T10:05:00Z');

    const updated = repository.update(
      'session-1',
      {
        sdkSessionId: 'sdk-1',
        status: 'failed',
        lastError: 'boom',
        pendingMessage: null,
      },
      later,
    );

    expect(updated).toMatchObject({
      sdkSessionId: 'sdk-1',
      status: 'failed',
      lastError: 'boom',
      updatedAt: later,
    });
  });

  it('sets running sessions to waiting on startup', () => {
    repository.create(newSessionRecord({ id: 'running', status: 'running' }));
    repository.create(newSessionRecord({ id: 'waiting', status: 'waiting' }));
    repository.create(newSessionRecord({ id: 'failed', status: 'failed' }));

    expect(repository.stopRunningSessions()).toEqual(['running']);
    expect(
      repository
        .list()
        .map((s) => [s.id, s.status])
        .sort(),
    ).toEqual([
      ['failed', 'failed'],
      ['running', 'waiting'],
      ['waiting', 'waiting'],
    ]);
  });

  it('deletes directories and usage together with the session', () => {
    repository.create(newSession());
    new UsageRepository(db).record('session-1', null, {
      haiku: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        costUsd: 0.1,
      },
    });

    db.$client.prepare('DELETE FROM sessions').run();

    const count = (table: string) =>
      (
        db.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n;
    expect(count('session_directories')).toBe(0);
    expect(count('usage_records')).toBe(0);
  });
});
