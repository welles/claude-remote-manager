import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { AccountLimits } from '@claude-remote-manager/shared-types';
import {
  AccountLimitTracker,
  LIMITS_STALE_MS,
  LimitsService,
  PLAN_USAGE_REFRESH_INTERVAL_MS,
} from './limits.service';

const planUsage = (
  rateLimits: SDKControlGetUsageResponse['rate_limits'],
): SDKControlGetUsageResponse =>
  ({
    session: {} as SDKControlGetUsageResponse['session'],
    subscription_type: 'max',
    rate_limits_available: rateLimits !== null,
    rate_limits: rateLimits,
  }) as SDKControlGetUsageResponse;

describe('AccountLimitTracker', () => {
  let service: AccountLimitTracker;
  let published: AccountLimits[];
  const now = new Date('2026-03-01T12:00:00Z');

  beforeEach(() => {
    service = new AccountLimitTracker('main');
    published = [];
    service.changes$.subscribe((limits) => published.push(limits));
  });

  it('starts empty', () => {
    expect(service.get()).toEqual({
      accountId: 'main',
      windows: [],
      subscriptionType: null,
      updatedAt: null,
    });
  });

  it('applies rate limit events (fraction, epoch seconds)', () => {
    service.updateFromRateLimitEvent(
      {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 0.823,
        resetsAt: 1772380800,
      },
      now,
    );

    expect(service.get()).toEqual({
      accountId: 'main',
      windows: [
        {
          type: 'five_hour',
          label: 'Session (5 hours)',
          status: 'allowed_warning',
          utilization: 82.3,
          resetsAt: '2026-03-01T16:00:00.000Z',
          source: 'stream',
          updatedAt: now.toISOString(),
        },
      ],
      subscriptionType: null,
      updatedAt: now.toISOString(),
    });
    expect(published).toHaveLength(1);
  });

  it('applies plan usage including per-model weekly windows', () => {
    service.updateFromRateLimitEvent(
      { status: 'allowed', rateLimitType: 'seven_day' },
      now,
    );
    service.updateFromPlanUsage(
      planUsage({
        five_hour: {
          utilization: 12,
          resets_at: '2026-03-01T15:00:00.492006+00:00',
        },
        seven_day: { utilization: 40, resets_at: '2026-03-05T00:00:00Z' },
        seven_day_opus: null,
        model_scoped: [
          { display_name: 'Fable', utilization: 5, resets_at: null },
        ],
      }),
      now,
    );

    const limits = service.get();
    expect(limits.subscriptionType).toBe('max');
    expect(limits.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'five_hour',
          utilization: 12,
          resetsAt: '2026-03-01T15:00:00.492Z',
          source: 'usage',
        }),
        // The status from the stream survives a usage update without one.
        expect.objectContaining({
          type: 'seven_day',
          utilization: 40,
          status: 'allowed',
        }),
        expect.objectContaining({
          type: 'model:Fable',
          label: 'Week (Fable)',
          utilization: 5,
        }),
      ]),
    );
    expect(limits.windows.some((w) => w.type === 'seven_day_opus')).toBe(false);
  });

  it('keeps known windows when plan limits are unavailable', () => {
    service.updateFromRateLimitEvent(
      { status: 'allowed', rateLimitType: 'five_hour' },
      now,
    );
    service.updateFromPlanUsage(planUsage(null), now);
    expect(service.get().windows).toHaveLength(1);
  });

  it('throttles plan usage requests and survives failures', async () => {
    const request = jest.fn().mockRejectedValue(new Error('unsupported'));
    await service.refreshPlanUsage(request, 1_000_000);
    await service.refreshPlanUsage(request, 1_000_000 + 1000);
    expect(request).toHaveBeenCalledTimes(1);

    request.mockResolvedValue(
      planUsage({ five_hour: { utilization: 1, resets_at: null } }),
    );
    await service.refreshPlanUsage(
      request,
      1_000_000 + PLAN_USAGE_REFRESH_INTERVAL_MS,
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(service.get().windows[0]).toMatchObject({
      type: 'five_hour',
      utilization: 1,
    });
  });

  it('drops windows a later plan usage answer no longer lists', () => {
    service.updateFromPlanUsage(
      planUsage({
        five_hour: { utilization: 3, resets_at: null },
        model_scoped: [
          { display_name: 'Fable', utilization: 5, resets_at: null },
        ],
      }),
      now,
    );
    service.updateFromPlanUsage(
      planUsage({ five_hour: { utilization: 4, resets_at: null } }),
      now,
    );
    expect(service.get().windows.map((window) => window.type)).toEqual([
      'five_hour',
    ]);
  });

  it('reads stale or unknown limits through the probe when asked', async () => {
    const source = jest
      .fn()
      .mockResolvedValue(
        planUsage({ five_hour: { utilization: 7, resets_at: null } }),
      );
    // Without a source nothing happens.
    service.refreshIfStale(Date.now());
    service.setPlanUsageSource(source);
    service.refreshIfStale(Date.now());
    await new Promise((resolve) => setImmediate(resolve));
    expect(source).toHaveBeenCalledTimes(1);
    expect(published.at(-1)?.windows[0]).toMatchObject({ utilization: 7 });
    // Fresh values are not read again.
    service.refreshIfStale(Date.now() + 1000);
    expect(source).toHaveBeenCalledTimes(1);
    service.refreshIfStale(Date.now() + LIMITS_STALE_MS + 1000);
    expect(source).toHaveBeenCalledTimes(2);
  });
  it('says until when the exhausted windows reset', () => {
    const at = now.getTime();
    // Rejected in the stream: exhausted until its reset.
    service.updateFromRateLimitEvent(
      {
        status: 'rejected',
        rateLimitType: 'five_hour',
        resetsAt: Date.parse('2026-03-01T14:00:00Z') / 1000,
      },
      now,
    );
    expect(service.exhaustedUntil([], at)?.toISOString()).toBe(
      '2026-03-01T14:00:00.000Z',
    );
    // A later usage answer without status counts by its utilization.
    service.updateFromPlanUsage(
      planUsage({
        five_hour: { utilization: 30, resets_at: '2026-03-01T14:00:00Z' },
        seven_day: { utilization: 100, resets_at: '2026-03-04T00:00:00Z' },
        seven_day_opus: { utilization: 100, resets_at: '2026-03-06T00:00:00Z' },
      }),
      now,
    );
    expect(service.exhaustedUntil([], at)?.toISOString()).toBe(
      '2026-03-04T00:00:00.000Z',
    );
    // Other windows count only when asked for.
    expect(service.exhaustedUntil(['seven_day_opus'], at)?.toISOString()).toBe(
      '2026-03-06T00:00:00.000Z',
    );
    // Resets that lie behind do not count.
    expect(
      service.exhaustedUntil([], Date.parse('2026-03-07T00:00:00Z')),
    ).toBeNull();
  });

  it('reads the plan usage now, once for callers at the same time', async () => {
    expect(await service.readNow()).toBe(false);
    let calls = 0;
    service.setPlanUsageSource(async () => {
      calls++;
      return planUsage({
        five_hour: { utilization: 100, resets_at: '2026-03-01T14:00:00Z' },
      });
    });
    expect(await Promise.all([service.readNow(), service.readNow()])).toEqual([
      true,
      true,
    ]);
    expect(calls).toBe(1);
    expect(service.get().windows[0]).toMatchObject({ utilization: 100 });
    service.setPlanUsageSource(async () => {
      throw new Error('probe failed');
    });
    expect(await service.readNow()).toBe(false);
  });
});

describe('LimitsService', () => {
  it('keeps the limits per account and lists them in the accounts order', async () => {
    const limits = new LimitsService();
    const published: AccountLimits[] = [];
    limits.changes$.subscribe((value) => published.push(value));
    const source = jest.fn(async (accountId: string) =>
      planUsage({
        five_hour: {
          utilization: accountId === 'b' ? 90 : 10,
          resets_at: null,
        },
      }),
    );
    limits.setPlanUsageSource(source);
    limits.setAccounts(() => ['b', 'main']);

    expect(await limits.account('b').readNow()).toBe(true);
    expect(source).toHaveBeenCalledWith('b');
    limits.account('main').updateFromRateLimitEvent({
      status: 'allowed',
      rateLimitType: 'seven_day',
    });

    expect(limits.list().map((value) => value.accountId)).toEqual([
      'b',
      'main',
    ]);
    expect(limits.get('b').windows[0]).toMatchObject({ utilization: 90 });
    expect(limits.get('main').windows[0]).toMatchObject({ type: 'seven_day' });
    expect(published.map((value) => value.accountId)).toEqual(['b', 'main']);

    limits.forget('b');
    expect(limits.get('b').windows).toEqual([]);
  });
});
