import { openDatabase, type AppDatabase } from '../db/database';
import { SessionRepository } from '../sessions/session.repository';
import { newSessionRecord, plainDirectory } from '../sessions/testing/records';
import { UsageRepository } from '../sessions/usage.repository';
import {
  bucketOf,
  bucketsBetween,
  dayNumber,
  defaultFrom,
  isTimeZone,
  localDateFormatter,
} from './calendar';
import { UsageStatisticsService } from './usage-statistics.service';

describe('calendar', () => {
  it('buckets dates into days, ISO weeks and months', () => {
    expect(bucketOf('2026-11-13', 'day')).toBe('2026-11-13');
    // 2026-11-13 is a Friday; its week starts on Monday the 9th.
    expect(bucketOf('2026-11-13', 'week')).toBe('2026-11-09');
    expect(bucketOf('2026-11-09', 'week')).toBe('2026-11-09');
    expect(bucketOf('2026-11-15', 'week')).toBe('2026-11-09');
    expect(bucketOf('2026-01-01', 'week')).toBe('2025-12-29');
    expect(bucketOf('2026-11-13', 'month')).toBe('2026-11-01');
    expect(bucketsBetween('2026-11-28', '2027-02-02', 'month')).toEqual([
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
    ]);
    expect(bucketsBetween('2026-11-13', '2026-11-24', 'week')).toEqual([
      '2026-11-09',
      '2026-11-16',
      '2026-11-23',
    ]);
    expect(defaultFrom('2026-11-13', 'day')).toBe('2026-10-15');
    expect(defaultFrom('2026-11-13', 'week')).toBe('2026-08-24');
    expect(defaultFrom('2026-11-13', 'month')).toBe('2025-12-01');
  });

  it('refuses dates that do not exist', () => {
    expect(dayNumber('2026-02-30')).toBeNaN();
    expect(dayNumber('2026-2-3')).toBeNaN();
    expect(dayNumber('2026-02-28')).not.toBeNaN();
  });

  it('knows time zones and their dates', () => {
    expect(isTimeZone('Europe/Berlin')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone(42)).toBe(false);
    const time = Date.parse('2026-11-12T23:30:00Z');
    expect(localDateFormatter('UTC')(time)).toBe('2026-11-12');
    expect(localDateFormatter('Europe/Berlin')(time)).toBe('2026-11-13');
    expect(localDateFormatter('America/Los_Angeles')(time)).toBe('2026-11-12');
    expect(localDateFormatter('Asia/Kathmandu')(time)).toBe('2026-11-13');
  });
});

describe('UsageStatisticsService', () => {
  let db: AppDatabase;
  let sessions: SessionRepository;
  let usage: UsageRepository;
  let statistics: UsageStatisticsService;
  const now = Date.parse('2026-11-13T12:00:00Z');

  const usageOf = (tokens: number, cost: number) => ({
    inputTokens: tokens,
    outputTokens: tokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: tokens,
    costUsd: cost,
  });

  beforeEach(() => {
    db = openDatabase(':memory:');
    sessions = new SessionRepository(db);
    usage = new UsageRepository(db);
    statistics = new UsageStatisticsService(db, sessions);
    sessions.create(
      newSessionRecord({
        id: 'a',
        title: 'Session A',
        directories: [plainDirectory('/w/a')],
      }),
    );
    sessions.create(
      newSessionRecord({
        id: 'b',
        title: 'Session B',
        directories: [plainDirectory('/w/b')],
      }),
    );
    usage.record(
      'a',
      null,
      { 'claude-haiku': usageOf(10, 0.1), 'claude-sonnet': usageOf(5, 0.5) },
      new Date('2026-11-12T23:30:00Z'),
    );
    usage.record(
      'b',
      null,
      { 'claude-haiku': usageOf(1, 0.01) },
      new Date('2026-11-13T08:00:00Z'),
    );
    usage.record(
      'b',
      null,
      { 'claude-haiku': usageOf(2, 0.02) },
      new Date('2026-10-01T08:00:00Z'),
    );
  });

  afterEach(() => db.$client.close());

  it('sums per day in the given time zone, by session', () => {
    const utc = statistics.statistics({ tz: 'UTC' }, now);
    expect(utc).toMatchObject({
      granularity: 'day',
      groupBy: 'session',
      timeZone: 'UTC',
      from: '2026-10-15',
      to: '2026-11-13',
      requests: 2,
    });
    expect(utc.buckets).toHaveLength(30);
    const a = utc.series.find((entry) => entry.key === 'a');
    expect(a).toMatchObject({ label: 'Session A', sessionId: 'a' });
    expect(a?.values[utc.buckets.indexOf('2026-11-12')].costUsd).toBe(0.6);
    expect(utc.totals.costUsd).toBe(0.61);
    // In Berlin the late request of the 12th belongs to the 13th.
    const berlin = statistics.statistics({ tz: 'Europe/Berlin' }, now);
    const berlinA = berlin.series.find((entry) => entry.key === 'a');
    expect(berlinA?.values[berlin.buckets.indexOf('2026-11-13')].costUsd).toBe(
      0.6,
    );
    // An unknown zone falls back to UTC.
    expect(statistics.statistics({ tz: 'Nowhere/Else' }, now).timeZone).toBe(
      'UTC',
    );
  });

  it('groups by model and by month, highest cost first', () => {
    const result = statistics.statistics(
      { tz: 'UTC', granularity: 'month', groupBy: 'model' },
      now,
    );
    expect(result.buckets.slice(-2)).toEqual(['2026-10-01', '2026-11-01']);
    expect(result.series.map((entry) => entry.key)).toEqual([
      'claude-sonnet',
      'claude-haiku',
    ]);
    const haiku = result.series[1];
    expect(haiku.values.slice(-2).map((value) => value.inputTokens)).toEqual([
      2, 11,
    ]);
    expect(result.requests).toBe(3);
  });

  it('keeps deleted sessions under their title and repositories', () => {
    sessions.delete('a');
    const bySession = statistics.statistics({ tz: 'UTC' }, now);
    expect(bySession.series.find((entry) => entry.key === 'a')).toMatchObject({
      label: 'Session A',
      state: 'deleted',
      sessionId: null,
    });
    const byRepository = statistics.statistics(
      { tz: 'UTC', groupBy: 'repository' },
      now,
    );
    expect(byRepository.series.map((entry) => entry.label)).toEqual([
      'No repository (scratch)',
    ]);
    expect(byRepository.totals.costUsd).toBe(0.61);
  });

  it('validates the range', () => {
    expect(() =>
      statistics.statistics({ from: '2026-11-14', to: '2026-11-13' }, now),
    ).toThrow('after');
    expect(() => statistics.statistics({ from: 'yesterday' }, now)).toThrow(
      'date',
    );
    expect(() =>
      statistics.statistics({ from: '2020-01-01', to: '2026-01-01' }, now),
    ).toThrow('too many');
    expect(
      statistics.statistics(
        { granularity: 'bogus', groupBy: 'bogus', tz: 'UTC' },
        now,
      ),
    ).toMatchObject({ granularity: 'day', groupBy: 'session' });
  });
});
