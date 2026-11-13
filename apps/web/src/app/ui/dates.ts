import { Pipe, type PipeTransform } from '@angular/core';

/**
 * The one date rule of the app: English like the rest of the UI, day
 * before month and a 24-hour clock ("15 Oct", "Mon 21:15",
 * "13 Nov 2026, 16:27"), whatever the browser's language; the time zone is
 * the browser's. Formatted with `Intl` (`en-GB`), never with Angular's
 * locale data.
 */
export const APP_LOCALE = 'en-GB';

const formats = new Map<string, Intl.DateTimeFormat>();

/** A cached `Intl.DateTimeFormat` in the app's (or the given) locale. */
export function dateFormat(
  options: Intl.DateTimeFormatOptions,
  locale: string = APP_LOCALE,
): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    formats.set(key, format);
  }
  return format;
}

/**
 * - `dateTime`: date and time, e.g. `13 Nov 2026, 16:27`;
 * - `long`: the same with the weekday, e.g. `Fri, 13 Nov 2026, 16:27`;
 * - `date`: e.g. `13 Nov 2026`;
 * - `time`: e.g. `16:27`;
 * - `relative`: `now`, `5 min`, `3 h`, `yesterday`, then the date.
 */
export type DateStyle = 'dateTime' | 'long' | 'date' | 'time' | 'relative';

const STYLES: Record<
  Exclude<DateStyle, 'relative'>,
  Intl.DateTimeFormatOptions
> = {
  dateTime: {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  },
  long: {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  },
  date: { day: 'numeric', month: 'short', year: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
};

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

/** Relative time for lists: `now`, `5 min`, `3 h`, `yesterday`, a date. */
export function formatRelative(
  value: string | number | Date,
  now: number = Date.now(),
  locale?: string,
): string {
  const date = toDate(value);
  const minutes = Math.floor((now - date.getTime()) / 60_000);
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  if (minutes < 12 * 60 || sameDay(date, new Date(now))) {
    return `${Math.floor(minutes / 60)} h`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(date, yesterday)) {
    return 'yesterday';
  }
  const thisYear = date.getFullYear() === new Date(now).getFullYear();
  return dateFormat(
    thisYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' },
    locale,
  ).format(date);
}

/** A time, with the weekday when it is not today (e.g. limit resets). */
export function formatClock(
  value: string | number | Date,
  now: number = Date.now(),
  locale?: string,
): string {
  const date = toDate(value);
  return dateFormat(
    sameDay(date, new Date(now))
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : {
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        },
    locale,
  ).format(date);
}

export function formatDate(
  value: string | number | Date,
  style: DateStyle = 'dateTime',
  now: number = Date.now(),
  locale?: string,
): string {
  if (style === 'relative') {
    return formatRelative(value, now, locale);
  }
  return dateFormat(STYLES[style], locale).format(toDate(value));
}

/**
 * `{{ iso | appDate }}`, `{{ iso | appDate: 'relative' : now() }}`: see
 * {@link formatDate}. Empty for `null`.
 */
@Pipe({ name: 'appDate' })
export class AppDatePipe implements PipeTransform {
  transform(
    value: string | number | Date | null | undefined,
    style: DateStyle = 'dateTime',
    now?: number,
  ): string {
    return value === null || value === undefined || value === ''
      ? ''
      : formatDate(value, style, now ?? Date.now());
  }
}
