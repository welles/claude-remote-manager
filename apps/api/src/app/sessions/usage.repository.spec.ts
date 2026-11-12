import { openDatabase, type AppDatabase } from '../db/database';
import { SessionRepository } from './session.repository';
import { EMPTY_USAGE, UsageRepository } from './usage.repository';

describe('UsageRepository', () => {
  let db: AppDatabase;
  let usage: UsageRepository;

  const usageOf = (tokens: number, costUsd: number) => ({
    inputTokens: tokens,
    outputTokens: tokens * 2,
    cacheCreationInputTokens: tokens * 3,
    cacheReadInputTokens: tokens * 4,
    costUsd,
  });

  beforeEach(() => {
    db = openDatabase(':memory:');
    usage = new UsageRepository(db);
    const sessions = new SessionRepository(db);
    for (const id of ['s1', 's2']) {
      sessions.create({
        id,
        title: null,
        model: null,
        permissionMode: 'default',
        status: 'running',
        cwd: '/work',
        additionalDirectories: [],
      });
    }
  });

  afterEach(() => db.$client.close());

  it('stores one row per model with the session and SDK session', () => {
    const now = new Date('2026-02-01T00:00:00Z');
    usage.record(
      's1',
      'sdk-1',
      { 'claude-haiku': usageOf(1, 0.01), 'claude-opus': usageOf(10, 0.5) },
      now,
    );

    const rows = db.$client
      .prepare('SELECT * FROM usage_records ORDER BY model')
      .all();
    expect(rows).toEqual([
      expect.objectContaining({
        session_id: 's1',
        sdk_session_id: 'sdk-1',
        model: 'claude-haiku',
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
        cost_usd: 0.01,
        created_at: now.getTime(),
      }),
      expect.objectContaining({ model: 'claude-opus', input_tokens: 10 }),
    ]);
  });

  it('ignores empty records', () => {
    usage.record('s1', null, {});
    expect(usage.totalsBySession().size).toBe(0);
  });

  it('sums usage per session and per model', () => {
    usage.record('s1', 'sdk-1', { haiku: usageOf(1, 0.25) });
    usage.record('s1', 'sdk-1', {
      haiku: usageOf(2, 0.25),
      opus: usageOf(5, 1),
    });
    usage.record('s2', 'sdk-2', { opus: usageOf(7, 2) });

    expect(usage.totalsForSession('s1')).toEqual(usageOf(8, 1.5));
    expect(usage.totalsByModel('s1')).toEqual({
      haiku: usageOf(3, 0.5),
      opus: usageOf(5, 1),
    });
    const all = usage.totalsBySession();
    expect(all.get('s2')).toEqual(usageOf(7, 2));
    expect(usage.totalsBySession(['s2']).has('s1')).toBe(false);
    expect(usage.totalsBySession([]).size).toBe(0);
  });

  it('reports zero usage for sessions without records', () => {
    expect(usage.totalsForSession('s2')).toEqual(EMPTY_USAGE);
    expect(usage.totalsByModel('s2')).toEqual({});
  });
});
