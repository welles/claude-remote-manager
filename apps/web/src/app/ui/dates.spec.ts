import { formatClock, formatDate, formatRelative } from './dates';

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

  it('uses one locale for dates and times', () => {
    const date = new Date(2026, 10, 13, 16, 27);
    expect(formatDate(date, 'dateTime', now, 'de-DE')).toBe('13.11.26, 16:27');
    expect(formatDate(date, 'dateTime', now, 'en-US')).toBe(
      '11/13/26, 4:27 PM',
    );
    expect(formatDate(date, 'time', now, 'de-DE')).toBe('16:27');
  });

  it('adds the weekday to clock times of other days', () => {
    expect(formatClock(new Date(2026, 10, 13, 21, 15), now, 'en-GB')).toBe(
      '21:15',
    );
    expect(formatClock(new Date(2026, 10, 16, 21, 15), now, 'en-GB')).toBe(
      'Mon 21:15',
    );
  });
});
