import { createHmac, timingSafeEqual } from 'node:crypto';
import { readSecret } from '../notifications/secrets';
import { WEBHOOK_SECRET_VARIABLE } from '../config/app-config';

/**
 * The secret GitHub signs webhook deliveries with (`X-Hub-Signature-256`,
 * HMAC-SHA256 of the raw body). Read once at startup from
 * `GITHUB_WEBHOOK_SECRET_FILE` or `CRM_SECRET_GITHUB_WEBHOOK_SECRET`, kept
 * only in memory: never in the database, logs, API responses or the
 * environment of processes the app starts (the `CRM_SECRET_` prefix keeps
 * it out of child environments).
 */
export class WebhookSecret {
  private constructor(private readonly key: Buffer | null) {}

  /** Shortest secret accepted (GitHub recommends a long random value). */
  static readonly MIN_LENGTH = 16;

  /**
   * Without a configured secret the webhook refuses every delivery. A
   * secret that is configured but unreadable or too short stops the start.
   */
  static load(
    file: string | null,
    env: Record<string, string | undefined> = process.env,
  ): WebhookSecret {
    if (!file && !env[WEBHOOK_SECRET_VARIABLE]?.trim()) {
      return new WebhookSecret(null);
    }
    const { value, problem } = readSecret(file, WEBHOOK_SECRET_VARIABLE, env);
    if (!value) {
      throw new Error(`The GitHub webhook secret is unusable: ${problem}`);
    }
    if (value.length < WebhookSecret.MIN_LENGTH) {
      throw new Error(
        `The GitHub webhook secret must be at least ${WebhookSecret.MIN_LENGTH} characters long`,
      );
    }
    return new WebhookSecret(Buffer.from(value, 'utf8'));
  }

  /** A secret for tests. */
  static of(value: string | null): WebhookSecret {
    return new WebhookSecret(
      value === null ? null : Buffer.from(value, 'utf8'),
    );
  }

  get configured(): boolean {
    return this.key !== null;
  }

  /**
   * Checks `X-Hub-Signature-256` (`sha256=` and 64 hex digits) against the
   * HMAC of the raw body, in constant time.
   */
  verify(
    body: Buffer,
    header: string | string[] | undefined,
  ): 'ok' | 'not_configured' | 'missing' | 'malformed' | 'mismatch' {
    if (!this.key) {
      return 'not_configured';
    }
    if (header === undefined || header === '') {
      return 'missing';
    }
    const value = Array.isArray(header) ? header : [header];
    const match =
      value.length === 1 ? /^sha256=([0-9a-fA-F]{64})$/.exec(value[0]) : null;
    if (!match) {
      return 'malformed';
    }
    const given = Buffer.from(match[1], 'hex');
    const expected = createHmac('sha256', this.key).update(body).digest();
    return given.length === expected.length && timingSafeEqual(given, expected)
      ? 'ok'
      : 'mismatch';
  }
}

/** `sha256=<hex>` for a body (tests, and the README's example). */
export function signWebhookBody(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}
