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

/** The server's local date as `YYYY-MM-DD`. */
export function slugDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Session slug such as `2026-11-20-k3x9q2`: the day the session was
 * created plus a random suffix. Nothing of the prompt goes into it, so the
 * branch `claude/<slug>` (pushed to the remote) and the directory names
 * reveal nothing of the task. Safe as a directory name and in the branch
 * name (only `[a-z0-9-]`, no leading dash, no `..`, no `.lock`).
 */
export function newSlug(now = new Date(), suffix = randomSuffix()): string {
  return `${slugDate(now)}-${suffix}`;
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
