import type { UsageTotals } from './session';

/**
 * Usage statistics (`GET /api/usage`): tokens and theoretical API cost of
 * the recorded requests over time. The cost is what the requests would
 * have cost at API prices, as the Agent SDK estimates it; the subscription
 * costs the same whatever the usage.
 */

export type UsageGranularity = 'day' | 'week' | 'month';
export type UsageGroupBy = 'session' | 'repository' | 'model';

export const USAGE_GRANULARITIES: readonly UsageGranularity[] = [
  'day',
  'week',
  'month',
];
export const USAGE_GROUPS: readonly UsageGroupBy[] = [
  'session',
  'repository',
  'model',
];

/** One group (a session, a set of repositories, a model) over time. */
export interface UsageSeries {
  key: string;
  label: string;
  /** For sessions: deleted (usage kept) or archived. */
  state: 'deleted' | 'archived' | null;
  /** Session ID, to link to it (sessions that still exist). */
  sessionId: string | null;
  totals: UsageTotals;
  /** One entry per bucket, in the order of `buckets`. */
  values: UsageTotals[];
}

/** Response of `GET /api/usage`. */
export interface UsageStatistics {
  granularity: UsageGranularity;
  groupBy: UsageGroupBy;
  /** IANA time zone the day, week and month boundaries use. */
  timeZone: string;
  /** First and last day of the range (`YYYY-MM-DD`, in `timeZone`). */
  from: string;
  to: string;
  /**
   * Start day of each bucket (`YYYY-MM-DD`): days, weeks starting on
   * Monday (ISO weeks), or the first of the month.
   */
  buckets: string[];
  /** Groups with usage in the range, highest cost first. */
  series: UsageSeries[];
  totals: UsageTotals;
  /** Requests (result messages) in the range. */
  requests: number;
}
