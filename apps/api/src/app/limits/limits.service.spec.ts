import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { AccountLimits } from '@claude-remote-manager/shared-types';
import {
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

describe('LimitsService', () => {
  let service: LimitsService;
  let published: AccountLimits[];
  const now = new Date('2026-03-01T12:00:00Z');

  beforeEach(() => {
    service = new LimitsService();
    published = [];
    service.changes$.subscribe((limits) => published.push(limits));
  });

  it('starts empty', () => {
    expect(service.get()).toEqual({
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
        five_hour: { utilization: 12, resets_at: '2026-03-01T15:00:00Z' },
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
});
