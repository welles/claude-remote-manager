import { openDatabase, type AppDatabase } from '../db/database';
import { SessionRepository, type NewSession } from './session.repository';
import { UsageRepository } from './usage.repository';

const newSession = (overrides: Partial<NewSession> = {}): NewSession => ({
  id: 'session-1',
  title: 'Title',
  model: 'haiku',
  permissionMode: 'default',
  status: 'running',
  cwd: '/work/main',
  additionalDirectories: ['/work/second', '/work/third'],
  ...overrides,
});

describe('SessionRepository', () => {
  let db: AppDatabase;
  let repository: SessionRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repository = new SessionRepository(db);
  });

  afterEach(() => db.$client.close());

  it('creates a session with its additional directories in order', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    const created = repository.create(newSession(), now);

    expect(created).toEqual({
      id: 'session-1',
      sdkSessionId: null,
      title: 'Title',
      model: 'haiku',
      permissionMode: 'default',
      status: 'running',
      cwd: '/work/main',
      additionalDirectories: ['/work/second', '/work/third'],
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(repository.get('session-1')).toEqual(created);
  });

  it('returns undefined for unknown sessions', () => {
    expect(repository.get('missing')).toBeUndefined();
    expect(() => repository.require('missing')).toThrow('not found');
  });

  it('lists sessions by last update, newest first', () => {
    repository.create(
      newSession({ id: 'a', additionalDirectories: [] }),
      new Date('2026-01-01T10:00:00Z'),
    );
    repository.create(
      newSession({ id: 'b' }),
      new Date('2026-01-01T11:00:00Z'),
    );
    repository.update(
      'a',
      { status: 'waiting' },
      new Date('2026-01-01T12:00:00Z'),
    );

    const list = repository.list();
    expect(list.map((session) => session.id)).toEqual(['a', 'b']);
    expect(list[0].additionalDirectories).toEqual([]);
    expect(list[1].additionalDirectories).toEqual([
      '/work/second',
      '/work/third',
    ]);
  });

  it('updates fields and the update time', () => {
    repository.create(newSession(), new Date('2026-01-01T10:00:00Z'));
    const later = new Date('2026-01-01T10:05:00Z');

    const updated = repository.update(
      'session-1',
      { sdkSessionId: 'sdk-1', status: 'failed', lastError: 'boom' },
      later,
    );

    expect(updated).toMatchObject({
      sdkSessionId: 'sdk-1',
      status: 'failed',
      lastError: 'boom',
      updatedAt: later,
    });
  });

  it('finishes running and waiting sessions on startup', () => {
    repository.create(newSession({ id: 'running', status: 'running' }));
    repository.create(newSession({ id: 'waiting', status: 'waiting' }));
    repository.create(newSession({ id: 'failed', status: 'failed' }));

    expect(repository.finishActiveSessions()).toBe(2);
    expect(
      repository
        .list()
        .map((s) => [s.id, s.status])
        .sort(),
    ).toEqual([
      ['failed', 'failed'],
      ['running', 'finished'],
      ['waiting', 'finished'],
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
