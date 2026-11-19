import { MIN_MASKED_SECRET_LENGTH } from '@claude-remote-manager/shared-types';

export const MASK = '***';

/** Replaces secret values in strings and in JSON-like values. */
export type SecretMasker = <T>(value: T) => T;

/** Masks nothing (sessions without environment or secrets). */
export const NO_MASKING: SecretMasker = (value) => value;

/**
 * The strings to mask for the secrets of an environment: each secret
 * variable's value and each secret file's whole content and its lines, all
 * of at least {@link MIN_MASKED_SECRET_LENGTH} characters (shorter ones
 * would mask ordinary text).
 */
export function maskedStrings(
  secrets: { kind: 'variable' | 'file'; value: string }[],
): string[] {
  const strings = new Set<string>();
  const add = (text: string) => {
    if (text.length >= MIN_MASKED_SECRET_LENGTH) {
      strings.add(text);
    }
  };
  for (const secret of secrets) {
    add(secret.value);
    add(secret.value.trim());
    if (secret.kind === 'file') {
      for (const line of secret.value.split(/\r?\n/)) {
        add(line.trim());
      }
    }
  }
  return [...strings];
}

/**
 * A masker for these strings: every occurrence in any string of a value
 * (recursively through arrays and plain objects) becomes {@link MASK}.
 * Longer strings first, so a value containing another is masked whole.
 * Returns the same value when nothing changed.
 */
export function secretMasker(strings: string[]): SecretMasker {
  if (strings.length === 0) {
    return NO_MASKING;
  }
  const sorted = [...strings].sort((a, b) => b.length - a.length);
  const maskString = (text: string): string => {
    let result = text;
    for (const secret of sorted) {
      if (result.includes(secret)) {
        result = result.split(secret).join(MASK);
      }
    }
    return result;
  };
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return maskString(value);
    }
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const masked = visit(item);
        changed ||= masked !== item;
        return masked;
      });
      return changed ? next : value;
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const masked = visit(item);
        changed ||= masked !== item;
        next[key] = masked;
      }
      return changed ? next : value;
    }
    return value;
  };
  return <T>(value: T) => visit(value) as T;
}
