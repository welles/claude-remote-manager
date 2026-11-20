import { newSlug, randomSuffix, SLUG_PATTERN, slugDate } from './slug';

describe('slugs', () => {
  it('is the date plus a random suffix', () => {
    expect(newSlug(new Date(), 'abc123')).toMatch(/^\d{4}-\d{2}-\d{2}-abc123$/);
  });

  it('takes the date in the time zone TZ names, else in UTC', () => {
    // 23:30 UTC is already the next day in Berlin.
    const late = new Date(Date.UTC(2026, 10, 20, 23, 30));
    expect(slugDate(late, 'Europe/Berlin')).toBe('2026-11-21');
    expect(slugDate(late, 'UTC')).toBe('2026-11-20');
    expect(slugDate(late, undefined)).toBe('2026-11-20');
    expect(slugDate(late, '')).toBe('2026-11-20');
    expect(slugDate(late, 'Not/AZone')).toBe('2026-11-20');
    expect(slugDate(new Date(Date.UTC(2027, 0, 5)), 'UTC')).toBe('2027-01-05');
  });

  it('is unique and stays a safe name', () => {
    const slugs = new Set(Array.from({ length: 200 }, () => newSlug()));
    expect(slugs.size).toBe(200);
    for (const slug of slugs) {
      expect(slug).toMatch(SLUG_PATTERN);
    }
    expect(randomSuffix()).toMatch(/^[0-9a-z]{6}$/);
  });
});
