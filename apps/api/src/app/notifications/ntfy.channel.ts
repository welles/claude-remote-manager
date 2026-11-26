import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  NotificationEventType,
  TestNotificationResult,
} from '@claude-remote-manager/shared-types';
import {
  APP_CONFIG,
  NTFY_TOKEN_VARIABLE,
  type AppConfig,
  type NtfyConfig,
} from '../config/app-config';
import { shortId, type AppNotification } from './notification';
import { readSecret, redact } from './secrets';

/** ntfy tags (shown as emoji) per event. */
const TAGS: Record<NotificationEventType, string> = {
  approval: 'raising_hand',
  turn_finished: 'white_check_mark',
  stalled: 'hourglass',
  failed: 'x',
  automerge: 'question',
  merge_queue: 'leftwards_arrow_with_hook',
  pull_request_closed: 'twisted_rightwards_arrows',
};

const TIMEOUT_MS = 15_000;

/** Fetch, replaceable in tests. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const NTFY_FETCH = Symbol('NTFY_FETCH');

/**
 * Notifications through an ntfy server (`NTFY_URL`, `NTFY_TOPIC`),
 * authenticated with an access token as Bearer header. The token comes from
 * `NTFY_TOKEN_FILE` or `CRM_SECRET_NTFY_TOKEN`, is read once at startup and
 * kept only in memory: it is never logged, returned by the API or given to
 * other processes (and redacted from error texts, should a server echo it).
 *
 * Each notification gets an ntfy sequence ID derived from its key: a later
 * one with the same key replaces it in the ntfy app, and withdrawing it
 * deletes it there (`DELETE /<topic>/<sequence ID>`, ntfy 2.15 or later;
 * older servers ignore it). Links open the session under `PUBLIC_URL`.
 */
@Injectable()
export class NtfyChannel {
  private readonly logger = new Logger('Ntfy');
  readonly config: NtfyConfig | null;
  /** Private field: not part of `JSON.stringify` or `util.inspect`. */
  readonly #token: string | null;
  readonly problem: string | null;
  private readonly publicUrl: string | null;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(NTFY_FETCH) private readonly fetch: FetchLike,
  ) {
    this.config = config.notifications.ntfy;
    this.publicUrl = config.notifications.publicUrl;
    if (!this.config) {
      this.#token = null;
      this.problem = 'NTFY_URL and NTFY_TOPIC are not set';
      return;
    }
    const secret = readSecret(
      this.config.tokenFile,
      NTFY_TOKEN_VARIABLE,
      process.env,
    );
    this.#token = secret.value;
    this.problem = secret.value ? null : `access token: ${secret.problem}`;
    if (this.problem) {
      this.logger.warn(`ntfy is off: ${this.problem}`);
    }
  }

  get available(): boolean {
    return this.config !== null && this.#token !== null;
  }

  get tokenSet(): boolean {
    return this.#token !== null;
  }

  async show(notification: AppNotification): Promise<void> {
    const error = await this.publish({
      title: notification.title,
      message: notification.body,
      priority: notification.urgent ? 4 : 3,
      tags: [TAGS[notification.type]],
      ...(this.publicUrl
        ? { click: `${this.publicUrl}${notification.path}` }
        : {}),
      sequence_id: shortId(notification.key),
    });
    if (error) {
      this.logger.warn(`Sending to ntfy failed: ${error}`);
    }
  }

  async withdraw(keys: string[]): Promise<void> {
    const config = this.config;
    if (!config || !this.#token) {
      return;
    }
    for (const key of keys) {
      const error = await this.request(
        `${config.server}/${config.topic}/${shortId(key)}`,
        'DELETE',
      );
      if (error) {
        this.logger.warn(`Withdrawing an ntfy message failed: ${error}`);
      }
    }
  }

  async test(): Promise<TestNotificationResult> {
    if (!this.available) {
      return { ok: false, message: `ntfy is off: ${this.problem}` };
    }
    const error = await this.publish({
      title: 'Test notification',
      message: 'ntfy works for Claude Remote Manager.',
      priority: 3,
      tags: ['test_tube'],
      ...(this.publicUrl ? { click: `${this.publicUrl}/settings` } : {}),
    });
    return error
      ? { ok: false, message: `ntfy did not accept it: ${error}` }
      : {
          ok: true,
          message: `Sent to topic ${this.config?.topic} on ${this.config?.server}.`,
        };
  }

  /** Publishes a message; returns why it failed, or `null`. */
  private publish(message: Record<string, unknown>): Promise<string | null> {
    const config = this.config;
    if (!config || !this.#token) {
      return Promise.resolve(this.problem ?? 'not configured');
    }
    return this.request(
      `${config.server}/`,
      'POST',
      JSON.stringify({ topic: config.topic, ...message }),
    );
  }

  private async request(
    url: string,
    method: string,
    body?: string,
  ): Promise<string | null> {
    try {
      const response = await this.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body } : {}),
        // A redirect could carry the token elsewhere.
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) {
        return null;
      }
      let detail = '';
      try {
        const answer = (await response.json()) as { error?: unknown };
        if (typeof answer.error === 'string') {
          detail = `: ${answer.error}`;
        }
      } catch {
        // No JSON body.
      }
      const hint =
        response.status === 401 || response.status === 403
          ? ' (check the access token and its access to the topic)'
          : '';
      return redact(`HTTP ${response.status}${detail}${hint}`, this.#token);
    } catch (error) {
      const cause = (error as { cause?: { code?: unknown } }).cause?.code;
      const reason =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'no answer in time'
          : typeof cause === 'string'
            ? `not reachable (${cause})`
            : 'not reachable';
      return redact(reason, this.#token);
    }
  }
}
