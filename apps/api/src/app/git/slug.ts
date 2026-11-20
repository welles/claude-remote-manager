import { randomInt } from 'node:crypto';

const RANDOM_LENGTH = 6;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random suffix from a CSPRNG, uniform over base 36. */
export function randomSuffix(length = RANDOM_LENGTH): string {
  return Array.from(
    { length },
    () => ALPHABET[randomInt(ALPHABET.length)],
  ).join('');
}

/**
 * The date as `YYYY-MM-DD` in the time zone `TZ` names, or in UTC when
 * `TZ` is not set or not a valid IANA time zone.
 */
export function slugDate(date: Date, timeZone: string | undefined): string {
  const parts = (zone: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
  let found: Intl.DateTimeFormatPart[];
  try {
    found = parts(timeZone?.trim() || 'UTC');
  } catch {
    found = parts('UTC');
  }
  const part = (type: string) =>
    found.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Session slug such as `2026-11-20-k3x9q2`: the day the session was
 * created plus a random suffix. Nothing of the prompt goes into it, so the
 * branch `claude/<slug>` (pushed to the remote) and the directory names
 * reveal nothing of the task. Safe as a directory name and in the branch
 * name (only `[a-z0-9-]`, no leading dash, no `..`, no `.lock`).
 */
export function newSlug(now = new Date(), suffix = randomSuffix()): string {
  return `${slugDate(now, process.env['TZ'])}-${suffix}`;
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
