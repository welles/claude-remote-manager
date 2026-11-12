import { newSlug, randomSuffix, SLUG_PATTERN, slugBase } from './slug';

describe('slugs', () => {
  it.each([
    ['Fix the login bug', 'fix-the-login-bug'],
    ['  Größe ändern: Ärger & Ölwechsel!  ', 'grosse-andern-arger-olwechsel'],
    ['../../etc/passwd', 'etc-passwd'],
    ['--force', 'force'],
    ['refs/heads/main.lock', 'refs-heads-main-lock'],
    ['日本語', 'session'],
    ['', 'session'],
    [
      'Implement the new repository overview with orphaned worktrees marked',
      'implement-the-new-repository-overview',
    ],
    ['x'.repeat(60), 'x'.repeat(40)],
  ])('derives %j -> %j', (text, base) => {
    expect(slugBase(text)).toBe(base);
    expect(slugBase(text).length).toBeLessThanOrEqual(40);
  });

  it('appends a random suffix and stays a safe name', () => {
    expect(newSlug('Fix it', 'abc123')).toBe('fix-it-abc123');
    const slugs = new Set(
      Array.from({ length: 200 }, () => newSlug('Same title')),
    );
    expect(slugs.size).toBe(200);
    for (const slug of slugs) {
      expect(slug).toMatch(SLUG_PATTERN);
    }
    expect(randomSuffix()).toMatch(/^[0-9a-z]{6}$/);
  });
});
