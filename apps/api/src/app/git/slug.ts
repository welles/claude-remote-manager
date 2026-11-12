import { randomBytes } from 'node:crypto';

/** Length of the readable part of a slug. */
const MAX_BASE_LENGTH = 40;
const RANDOM_LENGTH = 6;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Readable part of a session slug: lower-case ASCII letters, digits and
 * single dashes, at most 40 characters, cut at a word boundary when
 * possible; `session` if nothing is left.
 */
export function slugBase(text: string): string {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!words) {
    return 'session';
  }
  if (words.length <= MAX_BASE_LENGTH) {
    return words;
  }
  const cut = words.slice(0, MAX_BASE_LENGTH + 1);
  const boundary = cut.lastIndexOf('-');
  return (
    boundary >= MAX_BASE_LENGTH / 2
      ? cut.slice(0, boundary)
      : words.slice(0, MAX_BASE_LENGTH)
  ).replace(/-+$/, '');
}

/** Random suffix from a CSPRNG, base 36. */
export function randomSuffix(length = RANDOM_LENGTH): string {
  const bytes = randomBytes(length);
  return [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

/**
 * Session slug such as `fix-the-login-bug-k3x9q2`: readable part plus a
 * random suffix. Safe as a directory name and in the branch name
 * `claude/<slug>` (only `[a-z0-9-]`, no leading dash, no `..`, no `.lock`).
 */
export function newSlug(text: string, suffix = randomSuffix()): string {
  return `${slugBase(text)}-${suffix}`;
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
