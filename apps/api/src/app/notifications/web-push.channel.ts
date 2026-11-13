import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as webPush from 'web-push';
import type {
  PushPayload,
  TestNotificationResult,
} from '@claude-remote-manager/shared-types';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import type { PushSubscriptionRow } from '../db/schema';
import { shortId, type AppNotification } from './notification';
import { PushSubscriptionRepository } from './push-subscription.repository';
import {
  DEFAULT_VAPID_SUBJECT,
  loadVapidKeys,
  type VapidKeyPair,
} from './vapid-keys';

/** Options of one push message. */
export interface PushOptions {
  /** Seconds the push service keeps it for an offline device. */
  ttl: number;
  urgency: 'low' | 'normal' | 'high';
  /** Replaces an undelivered message with the same topic at the push service. */
  topic: string | null;
}

/** Sends one encrypted Web Push message; replaced in tests. */
export abstract class PushSender {
  abstract send(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: PushOptions,
    vapid: VapidKeyPair & { subject: string },
  ): Promise<void>;
}

/** Sends with the `web-push` library (RFC 8030/8291/8292). */
export class WebPushLibrarySender extends PushSender {
  async send(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: PushOptions,
    vapid: VapidKeyPair & { subject: string },
  ): Promise<void> {
    await webPush.sendNotification(subscription, payload, {
      vapidDetails: {
        subject: vapid.subject,
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
      },
      TTL: options.ttl,
      urgency: options.urgency,
      ...(options.topic ? { topic: options.topic } : {}),
      contentEncoding: 'aes128gcm',
      timeout: 15_000,
    });
  }
}

/** Status of a push service answer, if the error carries one. */
function statusOf(error: unknown): number | null {
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : null;
}

/** Error text without the endpoint (a capability URL) or response details. */
function describe(error: unknown): string {
  const status = statusOf(error);
  if (status !== null) {
    return `the push service answered ${status}`;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string'
    ? `the push service could not be reached (${code})`
    : 'the push service could not be reached';
}

/**
 * Apple's push service requires every push to show a notification (Safari
 * revokes the subscription otherwise), so it gets no withdrawals.
 */
const NO_SILENT_PUSH_HOSTS = [/(^|\.)push\.apple\.com$/];

/** How long the push service keeps undelivered messages. */
const SHOW_TTL_S = 24 * 60 * 60;

/**
 * Web Push to the installed web app's service worker on every subscribed
 * device. Messages are encrypted for each device (only its browser can
 * read them) and signed with the server's VAPID key. Subscriptions the push
 * service reports gone (404, 410) are removed.
 */
@Injectable()
export class WebPushChannel {
  private readonly logger = new Logger('WebPush');
  /** Private field: not part of `JSON.stringify` or `util.inspect`. */
  readonly #keys: VapidKeyPair | null;
  readonly problem: string | null;
  private readonly subject: string;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly subscriptions: PushSubscriptionRepository,
    @Optional()
    private readonly sender: PushSender = new WebPushLibrarySender(),
  ) {
    const loaded = loadVapidKeys(
      config.notifications.vapid,
      config.dbDir,
      process.env,
      this.logger,
    );
    this.#keys = loaded.keys;
    this.problem = loaded.problem;
    if (this.problem) {
      this.logger.warn(`Web Push is off: ${this.problem}`);
    }
    const publicUrl = config.notifications.publicUrl;
    this.subject =
      config.notifications.vapid.subject ??
      (publicUrl?.startsWith('https://') ? publicUrl : DEFAULT_VAPID_SUBJECT);
  }

  get available(): boolean {
    return this.#keys !== null;
  }

  /** The public VAPID key for the browsers' `PushManager.subscribe`. */
  get publicKey(): string | null {
    return this.#keys?.publicKey ?? null;
  }

  /** Shows a notification on every subscribed device. */
  async show(
    notification: AppNotification,
    badge: number | null,
  ): Promise<void> {
    const payload: PushPayload = {
      type: 'show',
      tag: notification.key,
      title: notification.title,
      body: notification.body,
      url: notification.path,
      sessionId: notification.sessionId,
      requestId: notification.requestId,
      actions: notification.actions,
      renotify: true,
      badge,
      timestamp: notification.at,
    };
    await this.deliver(payload, {
      ttl: SHOW_TTL_S,
      urgency: notification.urgent ? 'high' : 'normal',
      topic: shortId(notification.key),
    });
  }

  /**
   * Closes notifications that are no longer current. Same topic as the
   * notification: a push service that still holds it for an offline device
   * replaces it, so the device never shows it.
   */
  async withdraw(keys: string[], badge: number | null): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    await this.deliver(
      { type: 'withdraw', tags: keys, badge },
      {
        ttl: SHOW_TTL_S,
        urgency: 'normal',
        topic: keys.length === 1 ? shortId(keys[0]) : null,
      },
      (subscription) =>
        !NO_SILENT_PUSH_HOSTS.some((host) =>
          host.test(new URL(subscription.endpoint).hostname),
        ),
    );
  }

  async test(): Promise<TestNotificationResult> {
    if (!this.#keys) {
      return { ok: false, message: `Web Push is off: ${this.problem}` };
    }
    const result = await this.deliver(
      {
        type: 'show',
        tag: 'test',
        title: 'Test notification',
        body: 'Web Push works on this device.',
        url: '/settings',
        sessionId: null,
        requestId: null,
        actions: [],
        renotify: true,
        badge: null,
        timestamp: Date.now(),
      },
      { ttl: 60 * 60, urgency: 'high', topic: null },
    );
    if (result.total === 0) {
      return {
        ok: false,
        message:
          'No device is subscribed. Enable notifications on this device first.',
      };
    }
    return result.failures.length === 0
      ? {
          ok: true,
          message: `Sent to ${result.total} device${result.total === 1 ? '' : 's'}.`,
        }
      : {
          ok: false,
          message: `Sent to ${result.total - result.failures.length} of ${result.total} devices; ${result.failures.join('; ')}.`,
        };
  }

  private async deliver(
    payload: PushPayload,
    options: PushOptions,
    include: (subscription: PushSubscriptionRow) => boolean = () => true,
  ): Promise<{ total: number; failures: string[] }> {
    const keys = this.#keys;
    if (!keys) {
      return { total: 0, failures: [] };
    }
    const targets = this.subscriptions.list().filter(include);
    const failures: string[] = [];
    const body = JSON.stringify(payload);
    await Promise.all(
      targets.map(async (subscription) => {
        try {
          await this.sender.send(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            body,
            options,
            { ...keys, subject: this.subject },
          );
          this.subscriptions.recordResult(subscription.id, null);
        } catch (error) {
          const status = statusOf(error);
          const host = new URL(subscription.endpoint).host;
          if (status === 404 || status === 410) {
            // The browser unsubscribed or the subscription expired.
            this.subscriptions.remove(subscription.id);
            this.logger.log(
              `Removed the push subscription ${subscription.label} (${host}): gone`,
            );
            failures.push(`${subscription.label}: subscription gone, removed`);
            return;
          }
          const reason = describe(error);
          this.subscriptions.recordResult(subscription.id, reason);
          this.logger.warn(
            `Push to ${subscription.label} (${host}) failed: ${reason}`,
          );
          failures.push(`${subscription.label}: ${reason}`);
        }
      }),
    );
    return { total: targets.length, failures };
  }
}
