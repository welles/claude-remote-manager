import { Injectable, Logger } from '@nestjs/common';
import { Subject, type Subscription } from 'rxjs';
import type { AgentPlanUsage, AgentRateLimit } from '../agent/agent-events';
import { MAIN_ACCOUNT_ID } from '@claude-remote-manager/shared-types';
import type {
  AccountLimits,
  RateLimitWindow,
} from '@claude-remote-manager/shared-types';

/** Minimum time between two plan usage requests to claude.ai. */
export const PLAN_USAGE_REFRESH_INTERVAL_MS = 60_000;
/**
 * When someone looks at the limits and they are older than this, they are
 * read again through a probe process (no session needs to run).
 */
export const LIMITS_STALE_MS = 5 * 60_000;

const LABELS: Record<string, string> = {
  five_hour: 'Session (5 hours)',
  seven_day: 'Week',
  seven_day_opus: 'Week (Opus)',
  seven_day_sonnet: 'Week (Sonnet)',
  seven_day_oauth_apps: 'Week (apps)',
  seven_day_overage_included: 'Week (incl. extra usage)',
  overage: 'Extra usage',
};

/**
 * Latest known subscription rate limits of one Claude account (5-hour and
 * weekly windows). Fed from `rate_limit_event` messages of the account's
 * sessions and from Claude Code's plan usage request after turns.
 */
export class AccountLimitTracker {
  private readonly logger = new Logger(AccountLimitTracker.name);
  private readonly windows = new Map<string, RateLimitWindow>();
  private subscriptionType: string | null = null;
  private updatedAt: string | null = null;
  private lastPlanUsageRequest = 0;
  private planUsageSource: (() => Promise<AgentPlanUsage>) | null = null;
  private readonly changes = new Subject<AccountLimits>();
  private reading: Promise<boolean> | null = null;

  /** Emits the complete state after every change. */
  readonly changes$ = this.changes.asObservable();

  constructor(readonly accountId: string) {}

  /**
   * How to read the plan usage without a running session (a short-lived
   * Claude Code process); set by {@link LimitsService}.
   */
  setPlanUsageSource(source: () => Promise<AgentPlanUsage>): void {
    this.planUsageSource = source;
  }

  /**
   * Reads the plan usage again in the background if it is unknown or
   * older than {@link LIMITS_STALE_MS}; the result is published.
   */
  refreshIfStale(now = Date.now()): void {
    const source = this.planUsageSource;
    const updated = this.updatedAt ? Date.parse(this.updatedAt) : 0;
    if (source && now - updated >= LIMITS_STALE_MS) {
      void this.refreshPlanUsage(source, now);
    }
  }

  /**
   * Reads the plan usage now (through the probe process), sharing a read
   * already in flight. Returns whether it worked; failures are logged.
   */
  readNow(now = Date.now()): Promise<boolean> {
    const source = this.planUsageSource;
    if (!source) {
      return Promise.resolve(false);
    }
    this.reading ??= (async () => {
      try {
        this.lastPlanUsageRequest = now;
        this.updateFromPlanUsage(await source());
        return true;
      } catch (error) {
        this.logger.warn(`Plan usage request failed: ${String(error)}`);
        return false;
      } finally {
        this.reading = null;
      }
    })();
    return this.reading;
  }

  /**
   * When the exhausted windows among `types` (and the 5-hour and weekly
   * window) reset, by the latest known values: the latest reset of a window
   * at 100 % (or whose requests were rejected) that lies ahead; `null` when
   * none of them is known to be exhausted.
   */
  exhaustedUntil(types: readonly string[], now = Date.now()): Date | null {
    let until: number | null = null;
    for (const type of new Set(['five_hour', 'seven_day', ...types])) {
      const window = this.windows.get(type);
      const reset = window?.resetsAt ? Date.parse(window.resetsAt) : NaN;
      if (!window || !(reset > now)) {
        continue;
      }
      // A rejection from the stream is only current while no newer usage
      // answer said otherwise (that one carries no status).
      const exhausted =
        (window.utilization !== null && window.utilization >= 100) ||
        (window.source === 'stream' && window.status === 'rejected');
      if (exhausted && (until === null || reset > until)) {
        until = reset;
      }
    }
    return until === null ? null : new Date(until);
  }

  get(): AccountLimits {
    return {
      accountId: this.accountId,
      windows: [...this.windows.values()],
      subscriptionType: this.subscriptionType,
      updatedAt: this.updatedAt,
    };
  }

  /** Applies a limit window a session's process reported during a turn. */
  updateFromRateLimit(limit: AgentRateLimit, now = new Date()): void {
    const type = limit.window ?? 'unknown';
    this.merge(type, {
      type,
      label: LABELS[type] ?? null,
      status: limit.status,
      utilization: limit.utilization,
      resetsAt: limit.resetsAt,
      source: 'stream',
      updatedAt: now.toISOString(),
    });
    this.publish(now);
  }

  /** Applies a plan usage answer (utilization in percent). */
  updateFromPlanUsage(usage: AgentPlanUsage, now = new Date()): void {
    this.subscriptionType = usage.subscriptionType;
    if (usage.windows) {
      const updatedAt = now.toISOString();
      const reported = new Set<string>();
      for (const window of usage.windows) {
        reported.add(window.window);
        this.merge(window.window, {
          type: window.window,
          label: window.label ?? LABELS[window.window] ?? null,
          status: null,
          utilization: window.utilization,
          resetsAt: window.resetsAt,
          source: 'usage',
          updatedAt,
        });
      }
      // A complete answer replaces an earlier one: windows it no longer
      // lists (e.g. a per-model week) are gone.
      for (const [key, window] of this.windows) {
        if (window.source === 'usage' && !reported.has(key)) {
          this.windows.delete(key);
        }
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
    request: () => Promise<AgentPlanUsage>,
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

/**
 * The limits of all accounts, one {@link AccountLimitTracker} per account,
 * created on first use. Emits every change of any account.
 */
@Injectable()
export class LimitsService {
  private readonly trackers = new Map<string, AccountLimitTracker>();
  private readonly subscriptions = new Map<string, Subscription>();
  private planUsageSource:
    | ((accountId: string) => Promise<AgentPlanUsage>)
    | null = null;
  private accountIds: () => string[] = () => [MAIN_ACCOUNT_ID];
  private refreshableIds: () => string[] = () => [MAIN_ACCOUNT_ID];
  private readonly changes = new Subject<AccountLimits>();

  /** Emits the complete state of an account after every change. */
  readonly changes$ = this.changes.asObservable();

  /** The tracker of an account (created on first use). */
  account(accountId: string): AccountLimitTracker {
    let tracker = this.trackers.get(accountId);
    if (!tracker) {
      tracker = new AccountLimitTracker(accountId);
      const source = this.planUsageSource;
      if (source) {
        tracker.setPlanUsageSource(() => source(accountId));
      }
      this.subscriptions.set(
        accountId,
        tracker.changes$.subscribe((limits) => this.changes.next(limits)),
      );
      this.trackers.set(accountId, tracker);
    }
    return tracker;
  }

  /**
   * How to read an account's plan usage without a running session (a
   * short-lived Claude Code process of the account); set by the sessions
   * module.
   */
  setPlanUsageSource(
    source: (accountId: string) => Promise<AgentPlanUsage>,
  ): void {
    this.planUsageSource = source;
    for (const [accountId, tracker] of this.trackers) {
      tracker.setPlanUsageSource(() => source(accountId));
    }
  }

  /**
   * The accounts in their order, and those whose limits can be read (logged
   * in); set by the accounts module.
   */
  setAccounts(ids: () => string[], refreshable: () => string[] = ids): void {
    this.accountIds = ids;
    this.refreshableIds = refreshable;
  }

  /** The limits of every account, in the accounts' order. */
  list(): AccountLimits[] {
    return this.accountIds().map((id) => this.account(id).get());
  }

  get(accountId: string): AccountLimits {
    return this.account(accountId).get();
  }

  /** Reads stale or unknown limits of the logged-in accounts in the background. */
  refreshIfStale(now = Date.now()): void {
    for (const id of this.refreshableIds()) {
      this.account(id).refreshIfStale(now);
    }
  }

  /** Forgets a removed account. */
  forget(accountId: string): void {
    this.subscriptions.get(accountId)?.unsubscribe();
    this.subscriptions.delete(accountId);
    this.trackers.delete(accountId);
  }
}
