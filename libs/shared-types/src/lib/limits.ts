/**
 * Subscription (plan) rate limits of a Claude account. They apply to the
 * whole account, not to a single session.
 */

/** Known limit windows; Claude Code may report further ones. */
export type RateLimitWindowType =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'seven_day_overage_included'
  | 'overage'
  | (string & {});

export interface RateLimitWindow {
  type: RateLimitWindowType;
  /** Human-readable label, e.g. for per-model weekly windows. */
  label: string | null;
  /** `allowed`, `allowed_warning` or `rejected`, when known. */
  status: 'allowed' | 'allowed_warning' | 'rejected' | null;
  /** Used share of the window in percent (0-100), when known. */
  utilization: number | null;
  /** When the window resets (ISO 8601), when known. */
  resetsAt: string | null;
  /** Where the value comes from. */
  source: 'stream' | 'usage';
  /** When this window was last updated (ISO 8601). */
  updatedAt: string;
}

/** Limits of one account; payload of `account.limits`. */
export interface AccountLimits {
  /** The account (see `AccountDto`). */
  accountId: string;
  /** Latest known state per window type. Empty until a session reported one. */
  windows: RateLimitWindow[];
  /** Subscription type such as `pro` or `max`, when known. */
  subscriptionType: string | null;
  /** When any value was last updated (ISO 8601), `null` if never. */
  updatedAt: string | null;
}

/** Response of `GET /api/limits`: every account, in the accounts' order. */
export interface AccountLimitsListResponse {
  accounts: AccountLimits[];
}
