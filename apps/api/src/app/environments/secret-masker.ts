import { MIN_MASKED_SECRET_LENGTH } from '@claude-remote-manager/shared-types';

export const MASK = '***';

/** Replaces secret values in strings and in JSON-like values. */
export type SecretMasker = (<T>(value: T) => T) & {
  /**
   * How much streamed text is held back (see {@link StreamMasker}): the
   * length of the longest single-line masked string, at most
   * {@link MAX_STREAM_HOLD}; 0 without secrets.
   */
  readonly longest: number;
  /** Masks one string. */
  readonly text: (text: string) => string;
};

function masker(
  visit: (value: unknown) => unknown,
  text: (value: string) => string,
  longest: number,
): SecretMasker {
  return Object.assign(<T>(value: T) => visit(value) as T, { longest, text });
}

/**
 * Streamed text is held back by at most this many characters. Multi-line
 * secrets (whole files, multi-line values) are masked whole only in
 * complete texts; in streams their values and long lines are masked (see
 * {@link maskedStrings}), so holding back the length of a whole file
 * (which would stop streaming) is not needed.
 */
export const MAX_STREAM_HOLD = 4096;

/** Masks nothing (sessions without environment or secrets). */
export const NO_MASKING: SecretMasker = masker(
  (value) => value,
  (text) => text,
  0,
);

/** Lines of a secret file masked on their own: long and without spaces. */
const MIN_FILE_LINE_LENGTH = 20;
/** `KEY=value`, `key: value`, `key = "value"` in a secret file. */
const ASSIGNMENT = /^\s*(?:export\s+)?["']?[\w.-]+["']?\s*[:=]\s*(.+?)\s*,?$/;

function unquote(text: string): string {
  const match = /^(["'])(.*)\1$/.exec(text);
  return match ? match[2] : text;
}

/**
 * The strings worth masking in the content of a secret file: the whole
 * content; values of JSON (string leaves, e.g. a service account's
 * `private_key`), of `KEY=value` and `key: value` lines; and lines of such
 * values that are long and without spaces (e.g. the body of a PEM key).
 * Ordinary lines (`apiVersion: v1`, `#!/bin/bash`) are not masked.
 */
function fileSecrets(content: string): string[] {
  const values = [content, content.trim()];
  try {
    const collect = (value: unknown): void => {
      if (typeof value === 'string') {
        values.push(value);
      } else if (Array.isArray(value)) {
        value.forEach(collect);
      } else if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(collect);
      }
    };
    collect(JSON.parse(content));
  } catch {
    // Not JSON.
  }
  for (const line of content.split(/\r?\n/)) {
    const match = ASSIGNMENT.exec(line);
    if (match) {
      values.push(unquote(match[1]));
    }
  }
  const strings: string[] = [];
  for (const value of values) {
    if (value.includes('\n')) {
      strings.push(value.trim());
      for (const line of value.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length >= MIN_FILE_LINE_LENGTH && !/\s/.test(trimmed)) {
          strings.push(trimmed);
        }
      }
    } else {
      strings.push(value);
    }
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length >= MIN_FILE_LINE_LENGTH && !/\s/.test(trimmed)) {
      strings.push(trimmed);
    }
  }
  return strings;
}

/**
 * The strings to mask for the secrets of an environment: each secret
 * variable's value, and for secret files what {@link fileSecrets} finds,
 * all of at least {@link MIN_MASKED_SECRET_LENGTH} characters (shorter
 * ones would mask ordinary text).
 */
export function maskedStrings(
  secrets: { kind: 'variable' | 'file'; value: string }[],
): string[] {
  const strings = new Set<string>();
  for (const secret of secrets) {
    // A multi-line variable (e.g. a PEM key) is treated like a file.
    const candidates =
      secret.kind === 'file' || secret.value.trim().includes('\n')
        ? fileSecrets(secret.value)
        : [secret.value, secret.value.trim()];
    for (const candidate of candidates) {
      if (candidate.length >= MIN_MASKED_SECRET_LENGTH) {
        strings.add(candidate);
      }
    }
  }
  return [...strings];
}

/**
 * Fields that are never masked: they identify or classify (event type,
 * IDs, sequence numbers, times), and a secret in them is not plausible
 * while changing them would break the app.
 */
function isStructuralKey(key: string): boolean {
  return (
    key === 'type' ||
    key === 'seq' ||
    key === 'at' ||
    key === 'id' ||
    key === 'state' ||
    key === 'status' ||
    /Id$/.test(key)
  );
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A masker for these strings: every occurrence in any string of a value
 * (recursively through arrays and plain objects, except structural fields)
 * becomes {@link MASK}. One regular expression, longest strings first, so
 * a value containing another is masked whole. Returns the same value when
 * nothing changed.
 */
export function secretMasker(strings: string[]): SecretMasker {
  if (strings.length === 0) {
    return NO_MASKING;
  }
  const sorted = [...new Set(strings)].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(sorted.map(escape).join('|'), 'g');
  const maskString = (text: string): string =>
    text.length < MIN_MASKED_SECRET_LENGTH ? text : text.replace(pattern, MASK);
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
        const masked = isStructuralKey(key) ? item : visit(item);
        changed ||= masked !== item;
        next[key] = masked;
      }
      return changed ? next : value;
    }
    return value;
  };
  const hold = sorted.find(
    (text) => !text.includes('\n') && text.length <= MAX_STREAM_HOLD,
  );
  return masker(visit, maskString, hold?.length ?? 0);
}

/**
 * Masks streamed text: the text of a draft arrives in small pieces, so a
 * secret is usually split across them. Keeps the raw text per draft and
 * releases only a prefix that can no longer become part of a secret (the
 * last `longest - 1` characters are held back, and a prefix never ends
 * inside a complete occurrence), masked. The rest comes with the complete
 * text block, which is masked as a whole.
 */
export class StreamMasker {
  private readonly drafts = new Map<
    string,
    { raw: string; released: number; sent: string }
  >();

  /** The masked text to send for a new piece (may be empty). */
  push(key: string, piece: string, mask: SecretMasker): string {
    if (mask.longest === 0) {
      // Nothing to hold back (no secrets, or only multi-line ones).
      return mask.text(piece);
    }
    const draft = this.drafts.get(key) ?? { raw: '', released: 0, sent: '' };
    draft.raw += piece;
    this.drafts.set(key, draft);
    let cut = Math.max(draft.released, draft.raw.length - (mask.longest - 1));
    // Never cut through a complete occurrence: extend to its end.
    for (;;) {
      const masked = mask.text(draft.raw.slice(0, cut));
      const whole = mask.text(draft.raw);
      // The prefix is safe when masking it gives a prefix of the whole.
      if (whole.startsWith(masked) || cut >= draft.raw.length) {
        break;
      }
      cut += 1;
    }
    if (cut <= draft.released) {
      return '';
    }
    const masked = mask.text(draft.raw.slice(0, cut));
    const next = masked.startsWith(draft.sent)
      ? masked.slice(draft.sent.length)
      : '';
    draft.released = cut;
    draft.sent = masked;
    return next;
  }

  /**
   * Ends a stream: the masked text not sent yet (also what was held back),
   * or `''`.
   */
  flush(key: string, mask: SecretMasker): string {
    const draft = this.drafts.get(key);
    this.drafts.delete(key);
    if (!draft) {
      return '';
    }
    const masked = mask.text(draft.raw);
    return masked.startsWith(draft.sent) ? masked.slice(draft.sent.length) : '';
  }

  /** Forgets a draft (its complete text arrived). */
  end(key: string): void {
    this.drafts.delete(key);
  }

  clear(): void {
    this.drafts.clear();
  }
}
