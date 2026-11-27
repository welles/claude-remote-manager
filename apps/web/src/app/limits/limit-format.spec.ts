import type {
  AccountLimits,
  RateLimitWindow,
} from '@claude-remote-manager/shared-types';
import { formatDuration, isStale, limitView, limitViews } from './limit-format';

const NOW = Date.parse('2026-03-01T12:00:00Z');
const window = (overrides: Partial<RateLimitWindow>): RateLimitWindow => ({
  type: 'five_hour',
  label: 'Session (5 hours)',
  status: null,
  utilization: 40,
  resetsAt: '2026-03-01T14:05:00Z',
  source: 'usage',
  updatedAt: '2026-03-01T11:59:00Z',
  ...overrides,
});

describe('limit presentation', () => {
  it('formats durations', () => {
    expect(formatDuration(30_000)).toBe('< 1 min');
    expect(formatDuration(45 * 60_000)).toBe('45 min');
    expect(formatDuration(125 * 60_000)).toBe('2 h 5 min');
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3 d 4 h');
  });

  it('shows percent, reset and level of a window', () => {
    expect(limitView(window({}), NOW)).toMatchObject({
      short: '5h',
      label: 'Session (5 hours)',
      percent: 40,
      percentText: '40%',
      resetText: expect.stringContaining('resets in 2 h 5 min'),
      resetPassed: false,
      level: 'normal',
    });
    expect(limitView(window({ utilization: 91.6 }), NOW)).toMatchObject({
      percentText: '92%',
      level: 'high',
    });
    expect(limitView(window({ status: 'rejected' }), NOW)).toMatchObject({
      level: 'exhausted',
    });
    expect(
      limitView(window({ utilization: null, resetsAt: null }), NOW),
    ).toMatchObject({
      percentText: '?',
      resetText: 'reset time unknown',
    });
    // Past its reset the value is old: said so, not shown as high.
    expect(
      limitView(
        window({ utilization: 99, resetsAt: '2026-03-01T11:00:00Z' }),
        NOW,
      ),
    ).toMatchObject({
      resetPassed: true,
      level: 'normal',
      resetText: expect.stringContaining('no newer value yet'),
    });
  });

  it('orders the windows and marks stale values', () => {
    const limits: AccountLimits = {
      accountId: 'main',
      windows: [
        window({ type: 'model:Fable', label: 'Week (Fable)' }),
        window({ type: 'seven_day', label: 'Week' }),
        window({ type: 'five_hour' }),
        window({ type: 'overage', label: 'Extra usage' }),
      ],
      subscriptionType: 'max',
      updatedAt: '2026-03-01T11:59:00Z',
    };
    expect(limitViews(limits, NOW).map((view) => view.short)).toEqual([
      '5h',
      'Week',
      'Week (Fable)',
    ]);
    expect(isStale(limits, NOW)).toBe(false);
    expect(isStale(limits, NOW + 60 * 60_000)).toBe(true);
    expect(isStale({ ...limits, updatedAt: null }, NOW)).toBe(true);
  });
});
