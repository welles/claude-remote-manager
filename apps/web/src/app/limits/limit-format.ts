import type {
  AccountLimits,
  RateLimitWindow,
} from '@claude-remote-manager/shared-types';

/** Values older than this are marked as possibly outdated. */
export const STALE_AFTER_MS = 15 * 60_000;

/** A limit window as shown in the UI. */
export interface LimitView {
  type: string;
  label: string;
  /** Short label for the compact header, e.g. `5h`. */
  short: string;
  /** Used share in percent, `null` when unknown. */
  percent: number | null;
  /** E.g. `91%`, or `?` when unknown. */
  percentText: string;
  /** E.g. `resets in 2 h 5 min (03:10)`. */
  resetText: string;
  /** The window was reset since the value was read: the value is old. */
  resetPassed: boolean;
  level: 'normal' | 'warning' | 'critical';
  updatedAt: string;
}

const ORDER = ['five_hour', 'seven_day'];

function shortLabel(window: RateLimitWindow): string {
  switch (window.type) {
    case 'five_hour':
      return '5h';
    case 'seven_day':
      return 'Week';
    default:
      return window.label ?? window.type;
  }
}

function label(window: RateLimitWindow): string {
  if (window.label) {
    return window.label;
  }
  return window.type.replace(/^model:/, 'Week ').replace(/_/g, ' ');
}

/** `2 h 5 min`, `3 d 4 h`, `45 min`, `< 1 min`. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return '< 1 min';
  }
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  }
  if (hours > 0) {
    return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  }
  return `${rest} min`;
}

/** Local time, with the weekday when it is not today. */
export function formatTime(iso: string, now: number): string {
  const time = new Date(iso);
  const sameDay = time.toDateString() === new Date(now).toDateString();
  return time.toLocaleString(undefined, {
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function limitView(window: RateLimitWindow, now: number): LimitView {
  const percent =
    window.utilization === null ? null : Math.round(window.utilization);
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : null;
  const resetPassed = reset !== null && reset <= now;
  let resetText = 'reset time unknown';
  if (reset !== null && window.resetsAt) {
    resetText = resetPassed
      ? `was reset at ${formatTime(window.resetsAt, now)}; no newer value yet`
      : `resets in ${formatDuration(reset - now)} (${formatTime(window.resetsAt, now)})`;
  }
  const level =
    window.status === 'rejected' || (percent ?? 0) >= 90
      ? 'critical'
      : window.status === 'allowed_warning' || (percent ?? 0) >= 75
        ? 'warning'
        : 'normal';
  return {
    type: window.type,
    label: label(window),
    short: shortLabel(window),
    percent,
    percentText: percent === null ? '?' : `${percent}%`,
    resetText,
    resetPassed,
    level: resetPassed ? 'normal' : level,
    updatedAt: window.updatedAt,
  };
}

/** The windows in a stable order: 5 hours, week, then the others. */
export function limitViews(limits: AccountLimits, now: number): LimitView[] {
  const rank = (type: string) => {
    const index = ORDER.indexOf(type);
    return index < 0 ? ORDER.length : index;
  };
  return [...limits.windows]
    .filter((window) => window.type !== 'overage')
    .sort((a, b) => rank(a.type) - rank(b.type) || a.type.localeCompare(b.type))
    .map((window) => limitView(window, now));
}

/** Whether the values are older than {@link STALE_AFTER_MS}. */
export function isStale(limits: AccountLimits, now: number): boolean {
  return (
    !limits.updatedAt || now - Date.parse(limits.updatedAt) > STALE_AFTER_MS
  );
}
