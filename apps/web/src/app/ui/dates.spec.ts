import {
  formatClock,
  formatDate,
  formatIsoMinute,
  formatRelative,
} from './dates';

describe('dates', () => {
  const now = new Date(2026, 10, 13, 16, 30).getTime();
  const ago = (minutes: number) => now - minutes * 60_000;

  it('formats relative times for lists', () => {
    expect(formatRelative(ago(0.5), now)).toBe('now');
    expect(formatRelative(ago(5), now)).toBe('5 min');
    expect(formatRelative(ago(150), now)).toBe('2 h');
    expect(formatRelative(new Date(2026, 10, 12, 9, 0), now)).toBe('yesterday');
    expect(formatRelative(new Date(2026, 9, 15, 9, 0), now, 'en-GB')).toBe(
      '15 Oct',
    );
    expect(formatRelative(new Date(2025, 9, 15, 9, 0), now, 'en-GB')).toBe(
      '15 Oct 2025',
    );
  });

  it('formats in English, day before month, 24-hour clock', () => {
    const date = new Date(2026, 10, 13, 16, 27);
    expect(formatDate(date, 'dateTime', now)).toBe('13 Nov 2026, 16:27');
    expect(formatDate(date, 'long', now)).toBe('Fri, 13 Nov 2026, 16:27');
    expect(formatDate(date, 'date', now)).toBe('13 Nov 2026');
    expect(formatDate(date, 'time', now)).toBe('16:27');
    expect(formatRelative(new Date(2026, 9, 15, 9, 0), now)).toBe('15 Oct');
  });

  it('adds the weekday to clock times of other days', () => {
    expect(formatClock(new Date(2026, 10, 13, 21, 15), now)).toBe('21:15');
    expect(formatClock(new Date(2026, 10, 16, 21, 15), now)).toBe('Mon 21:15');
  });

  it('formats yyyy-MM-dd HH:mm in the given time zone', () => {
    const late = '2026-11-20T23:30:00Z';
    expect(formatIsoMinute(late, 'UTC')).toBe('2026-11-20 23:30');
    expect(formatIsoMinute(late, 'Europe/Berlin')).toBe('2026-11-21 00:30');
    expect(formatIsoMinute('2027-01-05T08:05:00Z', 'UTC')).toBe(
      '2027-01-05 08:05',
    );
  });
});
