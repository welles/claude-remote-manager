import { isIP } from 'node:net';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  needsUser,
  type ApprovalActionRequest,
  ApprovalActionResult,
  NotificationStatusDto,
  PullRequestDto,
  PushSubscriptionDto,
  RegisterPushSubscriptionRequest,
  RemovePushSubscriptionRequest,
  TestNotificationRequest,
  TestNotificationResult,
  UpdateNotificationPreferencesRequest,
} from '@claude-remote-manager/shared-types';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import {
  optionalEnum,
  requireObject,
  requireString,
  requireUuid,
} from '../common/validation';
import { SessionsService } from '../sessions/sessions.service';
import { ViewerPresence } from '../sessions/viewer-presence';
import {
  notificationKeys,
  shorten,
  type AppNotification,
} from './notification';
import { NotificationPreferencesStore } from './notification-preferences';
import {
  approvalActions,
  pullRequestLabel,
  sessionContext,
} from './notification-text';
import { NtfyChannel } from './ntfy.channel';
import {
  PushSubscriptionRepository,
  pushSubscriptionDto,
} from './push-subscription.repository';
import { WebPushChannel } from './web-push.channel';

/** Channels a notification went out on. */
interface Sent {
  webPush: boolean;
  ntfy: boolean;
}

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const MAX_ENDPOINT_LENGTH = 2048;

/** Short device name from a user agent, e.g. `Chrome on Android`. */
export function deviceLabel(userAgent: string | undefined): string {
  const agent = userAgent ?? '';
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /SamsungBrowser\//.test(agent)
        ? 'Samsung Internet'
        : /Chrome\//.test(agent)
          ? 'Chrome'
          : /Safari\//.test(agent)
            ? 'Safari'
            : 'Browser';
  const system = /Android/.test(agent)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(agent)
      ? 'iOS'
      : /Mac OS X/.test(agent)
        ? 'macOS'
        : /Windows/.test(agent)
          ? 'Windows'
          : /Linux/.test(agent)
            ? 'Linux'
            : null;
  return system ? `${browser} on ${system}` : browser;
}

/**
 * Sends notifications over the channels the preferences enable (Web Push,
 * ntfy) and withdraws them when they are no longer current. Nothing is
 * sent about a session that an active client shows (see ViewerPresence).
 *
 * Other parts of the app report their events here; the PR automation
 * (later step) calls {@link notifyAutofixGaveUp} and
 * {@link notifyPullRequestClosed}.
 */
@Injectable()
export class NotificationsService implements OnModuleDestroy {
  private readonly logger = new Logger('Notifications');
  /** Notifications sent and still current, by key. */
  private readonly sent = new Map<string, Sent>();
  /** Deliveries per key run in order (a withdrawal after its notification). */
  private readonly queues = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly preferences: NotificationPreferencesStore,
    private readonly webPush: WebPushChannel,
    private readonly ntfy: NtfyChannel,
    private readonly subscriptions: PushSubscriptionRepository,
    private readonly sessions: SessionsService,
    private readonly presence: ViewerPresence,
  ) {}

  onModuleDestroy(): void {
    this.stopped = true;
  }

  /**
   * Sends a notification, unless its session is in front of the user or
   * no channel is enabled for its type. Returns whether it was sent.
   */
  notify(notification: AppNotification): boolean {
    if (this.stopped) {
      return false;
    }
    if (
      notification.sessionId &&
      this.presence.isViewed(notification.sessionId)
    ) {
      this.logger.debug(
        `Skipped ${notification.type} of ${notification.sessionId}: the session is open`,
      );
      return false;
    }
    const enabled = this.preferences.get()[notification.type];
    const channels: Sent = {
      webPush: enabled.webPush && this.webPush.available,
      ntfy: enabled.ntfy && this.ntfy.available,
    };
    if (!channels.webPush && !channels.ntfy) {
      return false;
    }
    this.sent.set(notification.key, channels);
    const badge = this.badge();
    this.enqueue(notification.key, async () => {
      await Promise.all([
        channels.webPush ? this.webPush.show(notification, badge) : null,
        channels.ntfy ? this.ntfy.show(notification) : null,
      ]);
    });
    return true;
  }

  /** Withdraws a notification that is no longer current, if it was sent. */
  withdraw(key: string): void {
    const channels = this.sent.get(key);
    if (!channels || this.stopped) {
      return;
    }
    this.sent.delete(key);
    const badge = this.badge();
    this.enqueue(key, async () => {
      await Promise.all([
        channels.webPush ? this.webPush.withdraw([key], badge) : null,
        channels.ntfy ? this.ntfy.withdraw([key]) : null,
      ]);
    });
  }

  /** Whether a notification with this key was sent and not withdrawn. */
  isCurrent(key: string): boolean {
    return this.sent.has(key);
  }

  /** Waits for the deliveries started so far (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.all(this.queues.values());
    }
  }

  /**
   * PR automation: autofix stopped after its attempt limit for this pull
   * request. `reason`: what kept failing, shortened in the notification.
   */
  notifyAutofixGaveUp(
    sessionId: string,
    pullRequest: PullRequestDto,
    attempts: number,
    reason: string | null = null,
  ): boolean {
    const session = this.sessionOrNull(sessionId);
    return this.notify({
      type: 'autofix_gave_up',
      key: notificationKeys.autofix(pullRequest.id),
      sessionId,
      title: `Autofix gave up: ${pullRequestLabel(pullRequest)}`,
      body: [
        `${attempts} attempt${attempts === 1 ? '' : 's'}${reason ? `: ${shorten(reason, 120)}` : ''}`,
        session ? sessionContext(session) : shorten(pullRequest.title, 80),
      ].join('\n'),
      path: `/sessions/${sessionId}`,
      requestId: null,
      actions: [],
      urgent: false,
      at: Date.now(),
    });
  }

  /** PR automation: a pull request of the session was merged or closed. */
  notifyPullRequestClosed(
    sessionId: string,
    pullRequest: PullRequestDto,
  ): boolean {
    const session = this.sessionOrNull(sessionId);
    const merged = pullRequest.state === 'merged';
    return this.notify({
      type: 'pull_request_closed',
      key: notificationKeys.pullRequest(pullRequest.id),
      sessionId,
      title: `${merged ? 'Merged' : 'Closed'}: ${pullRequestLabel(pullRequest)}`,
      body: [
        shorten(pullRequest.title, 120),
        session ? sessionContext(session) : null,
      ]
        .filter(Boolean)
        .join('\n'),
      path: `/sessions/${sessionId}`,
      requestId: null,
      actions: [],
      urgent: false,
      at: Date.now(),
    });
  }

  // --- REST -----------------------------------------------------------------

  status(): NotificationStatusDto {
    const ntfy = this.ntfy.config;
    return {
      preferences: this.preferences.get(),
      stallMinutes: this.config.notifications.stallMs / 60_000,
      publicUrl: this.config.notifications.publicUrl,
      webPush: {
        vapidPublicKey: this.webPush.publicKey,
        problem: this.webPush.problem,
        subscriptions: this.subscriptions.list().map(pushSubscriptionDto),
      },
      ntfy: {
        configured: ntfy !== null,
        server: ntfy?.server ?? null,
        topic: ntfy?.topic ?? null,
        tokenSet: this.ntfy.tokenSet,
        problem: ntfy ? this.ntfy.problem : null,
      },
    };
  }

  updatePreferences(
    request: UpdateNotificationPreferencesRequest,
  ): NotificationStatusDto {
    this.preferences.update(request);
    return this.status();
  }

  /**
   * Registers this device's push subscription (or updates it). Only https
   * endpoints on public host names: the API posts to it.
   */
  subscribe(
    request: RegisterPushSubscriptionRequest,
    userAgent: string | undefined,
  ): PushSubscriptionDto {
    if (!this.webPush.available) {
      throw new BadRequestException(`Web Push is off: ${this.webPush.problem}`);
    }
    const body = requireObject(request);
    const endpoint = this.endpoint(body);
    const keys = requireObject(body['keys'], 'keys');
    const p256dh = requireString(keys, 'p256dh', { maxLength: 200 });
    const auth = requireString(keys, 'auth', { maxLength: 100 });
    const key = Buffer.from(p256dh, 'base64url');
    if (!BASE64URL.test(p256dh) || key.length !== 65 || key[0] !== 4) {
      throw new BadRequestException('keys.p256dh is not a P-256 public key');
    }
    if (!BASE64URL.test(auth) || Buffer.from(auth, 'base64url').length < 16) {
      throw new BadRequestException('keys.auth is not an auth secret');
    }
    return pushSubscriptionDto(
      this.subscriptions.upsert({
        endpoint,
        p256dh,
        auth,
        label: deviceLabel(userAgent),
      }),
    );
  }

  /** Removes a device's subscription by its endpoint (from the device). */
  unsubscribeEndpoint(request: RemovePushSubscriptionRequest): void {
    const body = requireObject(request);
    this.subscriptions.removeByEndpoint(
      requireString(body, 'endpoint', { maxLength: MAX_ENDPOINT_LENGTH }),
    );
  }

  /** Removes a subscription from the list on the Settings page. */
  removeSubscription(id: string): void {
    if (!this.subscriptions.remove(id)) {
      throw new NotFoundException(`Push subscription ${id} not found`);
    }
  }

  async test(
    request: TestNotificationRequest,
  ): Promise<TestNotificationResult> {
    const body = requireObject(request);
    const channel = optionalEnum(body, 'channel', ['webPush', 'ntfy'] as const);
    if (!channel) {
      throw new BadRequestException('channel must be webPush or ntfy');
    }
    return channel === 'webPush' ? this.webPush.test() : this.ntfy.test();
  }

  /**
   * The Allow or Deny button of an approval notification. Answers only this
   * pending request of this session, and only as the notification offered:
   * Allow once (never for the session, never a mode change), Deny without
   * message. A request that is not pending anymore is left as it is.
   */
  async approvalAction(
    request: ApprovalActionRequest,
  ): Promise<ApprovalActionResult> {
    const body = requireObject(request);
    const sessionId = requireUuid(body, 'sessionId');
    const requestId = requireUuid(body, 'requestId');
    const action = optionalEnum(body, 'action', ['allow', 'deny'] as const);
    if (!action) {
      throw new BadRequestException('action must be allow or deny');
    }
    const pending = this.sessions
      .pendingPermissions(sessionId)
      .find((event) => event.requestId === requestId);
    if (!pending) {
      // Answered or cancelled before: left as it is.
      const resolved = await this.sessions.permissionResolution(
        sessionId,
        requestId,
      );
      if (!resolved) {
        throw new NotFoundException(
          `Approval request ${requestId} not found in session ${sessionId}`,
        );
      }
      return { outcome: 'already_resolved', decision: resolved.decision };
    }
    if (!approvalActions(pending).includes(action)) {
      return { outcome: 'not_offered', decision: null };
    }
    // No await between the check and the answer: nothing can answer the
    // request in between.
    const result = await this.sessions.respondToPermission(
      sessionId,
      requestId,
      action === 'allow'
        ? { decision: 'allow', scope: 'once' }
        : { decision: 'deny' },
    );
    return {
      outcome: result.alreadyResolved ? 'already_resolved' : 'applied',
      decision: result.resolved.decision,
    };
  }

  // -------------------------------------------------------------------------

  /** Sessions blocked on the user (see `needsUser`), for the app icon's badge. */
  badge(): number {
    return this.sessions.list().filter(needsUser).length;
  }

  private sessionOrNull(sessionId: string) {
    try {
      return this.sessions.get(sessionId);
    } catch {
      return null;
    }
  }

  private endpoint(body: Record<string, unknown>): string {
    const raw = requireString(body, 'endpoint', {
      maxLength: MAX_ENDPOINT_LENGTH,
    });
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException('endpoint must be a URL');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      isIP(host) !== 0 ||
      !host.includes('.') ||
      host === 'localhost' ||
      /\.(localhost|local|internal|home\.arpa)$/.test(host)
    ) {
      throw new BadRequestException(
        'endpoint must be an https URL of a push service',
      );
    }
    return url.href;
  }

  private enqueue(key: string, task: () => Promise<unknown>): void {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next: Promise<void> = previous
      .then(async () => {
        await task();
      })
      .catch((error: unknown) =>
        this.logger.error(`Delivering a notification failed: ${String(error)}`),
      )
      .finally(() => {
        if (this.queues.get(key) === next) {
          this.queues.delete(key);
        }
      });
    this.queues.set(key, next);
  }
}
