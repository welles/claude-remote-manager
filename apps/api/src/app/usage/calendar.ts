import type { UsageGranularity } from '@claude-remote-manager/shared-types';

const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** `YYYY-MM-DD` of an instant in a time zone. */
export function localDateFormatter(zone: string): (time: number) => string {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (time) => {
    const parts = format.formatToParts(time);
    const part = (type: string) =>
      parts.find((entry) => entry.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
}

/** A calendar date as days since 1970-01-01 (no time zone involved). */
export function dayNumber(date: string): number {
  const match = DATE.exec(date);
  if (!match) {
    return Number.NaN;
  }
  const [, year, month, day] = match.map(Number);
  const time = Date.UTC(year, month - 1, day);
  const back = new Date(time);
  // Refuses dates such as 2026-02-30.
  return back.getUTCMonth() === month - 1 && back.getUTCDate() === day
    ? time / DAY_MS
    : Number.NaN;
}

export function dateOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export const isDate = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(dayNumber(value));

export function addDays(date: string, days: number): string {
  return dateOf(dayNumber(date) + days);
}

/** Start of the bucket a date falls into: the date, its Monday, the 1st. */
export function bucketOf(date: string, granularity: UsageGranularity): string {
  if (granularity === 'day') {
    return date;
  }
  if (granularity === 'month') {
    return `${date.slice(0, 7)}-01`;
  }
  const day = dayNumber(date);
  // 1970-01-01 was a Thursday: (day + 3) % 7 is 0 on Mondays.
  return dateOf(day - ((day + 3) % 7));
}

/** The next bucket's start. */
export function nextBucket(
  start: string,
  granularity: UsageGranularity,
): string {
  if (granularity === 'day') {
    return addDays(start, 1);
  }
  if (granularity === 'week') {
    return addDays(start, 7);
  }
  const year = Number(start.slice(0, 4));
  const month = Number(start.slice(5, 7));
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

/** Start days of the buckets that cover `from` to `to`. */
export function bucketsBetween(
  from: string,
  to: string,
  granularity: UsageGranularity,
): string[] {
  const buckets: string[] = [];
  for (
    let bucket = bucketOf(from, granularity);
    bucket <= to;
    bucket = nextBucket(bucket, granularity)
  ) {
    buckets.push(bucket);
  }
  return buckets;
}

/** Default range ending today: 30 days, 12 weeks or 12 months. */
export function defaultFrom(today: string, granularity: UsageGranularity) {
  if (granularity === 'day') {
    return addDays(today, -29);
  }
  if (granularity === 'week') {
    return addDays(bucketOf(today, 'week'), -7 * 11);
  }
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const start = new Date(Date.UTC(year, month - 1 - 11, 1));
  return start.toISOString().slice(0, 10);
}
