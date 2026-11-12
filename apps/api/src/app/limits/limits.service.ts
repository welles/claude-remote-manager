import { Injectable, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import type {
  SDKControlGetUsageResponse,
  SDKRateLimitInfo,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AccountLimits,
  RateLimitWindow,
} from '@claude-remote-manager/shared-types';

/** Minimum time between two plan usage requests to claude.ai. */
export const PLAN_USAGE_REFRESH_INTERVAL_MS = 60_000;

const LABELS: Record<string, string> = {
  five_hour: 'Session (5 hours)',
  seven_day: 'Week',
  seven_day_opus: 'Week (Opus)',
  seven_day_sonnet: 'Week (Sonnet)',
  seven_day_oauth_apps: 'Week (apps)',
  seven_day_overage_included: 'Week (incl. extra usage)',
  overage: 'Extra usage',
};

/** `rate_limit_event` reports reset times as epoch seconds. */
function epochSecondsToIso(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

/** `rate_limit_event` reports utilization as a fraction (0-1). */
function fractionToPercent(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 1000) / 10;
}

/**
 * Latest known subscription rate limits of the Claude account (5-hour and
 * weekly windows). Fed from `rate_limit_event` messages of any session and
 * from Claude Code's plan usage request after turns.
 */
@Injectable()
export class LimitsService {
  private readonly logger = new Logger(LimitsService.name);
  private readonly windows = new Map<string, RateLimitWindow>();
  private subscriptionType: string | null = null;
  private updatedAt: string | null = null;
  private lastPlanUsageRequest = 0;
  private readonly changes = new Subject<AccountLimits>();

  /** Emits the complete state after every change. */
  readonly changes$ = this.changes.asObservable();

  get(): AccountLimits {
    return {
      windows: [...this.windows.values()],
      subscriptionType: this.subscriptionType,
      updatedAt: this.updatedAt,
    };
  }

  /** Applies a `rate_limit_event` from a session's message stream. */
  updateFromRateLimitEvent(info: SDKRateLimitInfo, now = new Date()): void {
    const type = info.rateLimitType ?? 'unknown';
    this.merge(type, {
      type,
      label: LABELS[type] ?? null,
      status: info.status,
      utilization: fractionToPercent(info.utilization),
      resetsAt: epochSecondsToIso(info.resetsAt),
      source: 'stream',
      updatedAt: now.toISOString(),
    });
    this.publish(now);
  }

  /** Applies Claude Code's plan usage answer (utilization in percent). */
  updateFromPlanUsage(
    usage: SDKControlGetUsageResponse,
    now = new Date(),
  ): void {
    this.subscriptionType = usage.subscription_type;
    const limits = usage.rate_limits;
    if (usage.rate_limits_available && limits) {
      const updatedAt = now.toISOString();
      const fixed = [
        'five_hour',
        'seven_day',
        'seven_day_opus',
        'seven_day_sonnet',
        'seven_day_oauth_apps',
      ] as const;
      for (const type of fixed) {
        const window = limits[type];
        if (window) {
          this.merge(type, {
            type,
            label: LABELS[type] ?? null,
            status: null,
            utilization: window.utilization,
            resetsAt: window.resets_at,
            source: 'usage',
            updatedAt,
          });
        }
      }
      for (const window of limits.model_scoped ?? []) {
        const type = `model:${window.display_name}`;
        this.merge(type, {
          type,
          label: `Week (${window.display_name})`,
          status: null,
          utilization: window.utilization,
          resetsAt: window.resets_at,
          source: 'usage',
          updatedAt,
        });
      }
    }
    this.publish(now);
  }

  /**
   * Requests the plan usage through a session's Claude Code process unless
   * that happened recently. Failures are logged, not thrown: the API behind
   * it is experimental.
   */
  async refreshPlanUsage(
    request: () => Promise<SDKControlGetUsageResponse>,
    now = Date.now(),
  ): Promise<void> {
    if (now - this.lastPlanUsageRequest < PLAN_USAGE_REFRESH_INTERVAL_MS) {
      return;
    }
    this.lastPlanUsageRequest = now;
    try {
      this.updateFromPlanUsage(await request());
    } catch (error) {
      this.logger.warn(`Plan usage request failed: ${String(error)}`);
    }
  }

  private merge(key: string, update: RateLimitWindow): void {
    const previous = this.windows.get(key);
    this.windows.set(key, {
      ...update,
      label: update.label ?? previous?.label ?? null,
      status: update.status ?? previous?.status ?? null,
      utilization: update.utilization ?? previous?.utilization ?? null,
      resetsAt: update.resetsAt ?? previous?.resetsAt ?? null,
    });
  }

  private publish(now: Date): void {
    this.updatedAt = now.toISOString();
    this.changes.next(this.get());
  }
}
