import { newSlug, randomSuffix, SLUG_PATTERN, slugDate } from './slug';

describe('slugs', () => {
  it('is the local date plus a random suffix', () => {
    expect(newSlug(new Date(2026, 10, 20, 23, 59), 'abc123')).toBe(
      '2026-11-20-abc123',
    );
    expect(slugDate(new Date(2027, 0, 5))).toBe('2027-01-05');
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
