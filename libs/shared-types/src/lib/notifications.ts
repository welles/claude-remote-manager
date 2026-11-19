/**
 * Notifications: what the API reports to the user while sessions run
 * unattended, over Web Push (the installed web app) and ntfy.
 */

/**
 * Events that cause a notification:
 * - `approval`: Claude waits for an approval, an answer to a question or a
 *   plan review;
 * - `turn_finished`: a turn ended and Claude waits for the next message;
 * - `stalled`: a running turn produced no event for the stall time;
 * - `failed`: the session failed (or its setup script, so that the first
 *   message is held back);
 * - `autofix_gave_up`: the PR automation stopped after its attempt limit;
 * - `automerge`: automerge waits for the owner's decision, GitHub refused
 *   the merge, or review threads nobody works on keep it from merging;
 * - `pull_request_closed`: a pull request of the session was merged or
 *   closed.
 */
export type NotificationEventType =
  | 'approval'
  | 'turn_finished'
  | 'stalled'
  | 'failed'
  | 'autofix_gave_up'
  | 'automerge'
  | 'pull_request_closed';

export const NOTIFICATION_EVENT_TYPES: readonly NotificationEventType[] = [
  'approval',
  'turn_finished',
  'stalled',
  'failed',
  'autofix_gave_up',
  'automerge',
  'pull_request_closed',
];

export type NotificationChannel = 'webPush' | 'ntfy';

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  'webPush',
  'ntfy',
];

export const NOTIFICATION_EVENT_INFO: Record<
  NotificationEventType,
  { label: string; description: string }
> = {
  approval: {
    label: 'Claude needs you',
    description:
      'An approval, a question or a plan to review. Web Push offers Allow and Deny for commands and file changes.',
  },
  turn_finished: {
    label: 'Turn finished',
    description: 'Claude finished its work and waits for your next message.',
  },
  stalled: {
    label: 'Session hangs',
    description:
      'A running session has shown no activity for the stall time (once per stall).',
  },
  failed: {
    label: 'Session failed',
    description:
      'Claude Code ended with an error, or a setup script failed and the first message is held back.',
  },
  autofix_gave_up: {
    label: 'Autofix gave up',
    description:
      'The PR automation reached its attempt limit and stopped fixing.',
  },
  automerge: {
    label: 'Automerge needs you',
    description:
      'Claude asked for your decision before merging, GitHub refused the merge, or review threads nobody works on keep it waiting.',
  },
  pull_request_closed: {
    label: 'Pull request merged or closed',
    description: 'A pull request of a session was merged or closed.',
  },
};

/** Per event type and channel: on or off. */
export type NotificationPreferences = Record<
  NotificationEventType,
  Record<NotificationChannel, boolean>
>;

/** A browser or device that receives Web Push notifications. */
export interface PushSubscriptionDto {
  id: string;
  /** Readable name of the device, from its user agent. */
  label: string;
  /** Host of the push service, e.g. `fcm.googleapis.com`. */
  pushService: string;
  createdAt: string;
  lastSuccessAt: string | null;
  /** Last delivery error, `null` after a success. */
  lastError: string | null;
}

/** Response of `GET /api/notifications`. */
export interface NotificationStatusDto {
  preferences: NotificationPreferences;
  /** Minutes without activity after which a running session hangs. */
  stallMinutes: number;
  /**
   * Public URL of the app (`PUBLIC_URL`): links in ntfy messages open the
   * session there. `null`: ntfy messages carry no link.
   */
  publicUrl: string | null;
  webPush: {
    /** Public VAPID key for `PushManager.subscribe`, `null` if unavailable. */
    vapidPublicKey: string | null;
    /** Why Web Push is not available. */
    problem: string | null;
    subscriptions: PushSubscriptionDto[];
  };
  ntfy: {
    configured: boolean;
    server: string | null;
    topic: string | null;
    /** Whether an access token was given (it is never shown). */
    tokenSet: boolean;
    /** Why ntfy cannot send. */
    problem: string | null;
  };
}

/** Body of `PUT /api/notifications/preferences`; missing entries stay. */
export interface UpdateNotificationPreferencesRequest {
  preferences: Partial<
    Record<NotificationEventType, Partial<Record<NotificationChannel, boolean>>>
  >;
}

/** Body of `POST /api/notifications/push-subscriptions` (from `PushSubscription.toJSON()`). */
export interface RegisterPushSubscriptionRequest {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Body of `POST /api/notifications/push-subscriptions/remove`. */
export interface RemovePushSubscriptionRequest {
  endpoint: string;
}

/** Body of `POST /api/notifications/test`. */
export interface TestNotificationRequest {
  channel: NotificationChannel;
}

/** Response of `POST /api/notifications/test`. */
export interface TestNotificationResult {
  ok: boolean;
  /** What happened, e.g. how many devices got it or why it failed. */
  message: string;
}

/**
 * Body of `POST /api/notifications/approval-actions`: the Allow or Deny
 * button of an approval notification. Answers exactly that pending request:
 * `allow` allows it once, `deny` denies it without message (the turn
 * stops). Never a session-wide allow or a mode change.
 */
export interface ApprovalActionRequest {
  sessionId: string;
  requestId: string;
  action: ApprovalAction;
}

export type ApprovalAction = 'allow' | 'deny';

/**
 * Response of `POST /api/notifications/approval-actions`:
 * - `applied`: the answer was given;
 * - `already_resolved`: the request had been answered or cancelled before;
 *   `decision` says how, nothing was changed;
 * - `not_offered`: this action is not available for the request from a
 *   notification (e.g. Allow for a push that updates more than the session
 *   branch, or a question); nothing was changed.
 */
export interface ApprovalActionResult {
  outcome: 'applied' | 'already_resolved' | 'not_offered';
  decision: 'allow' | 'deny' | null;
}

/**
 * Data of a Web Push message from the API to the service worker
 * (encrypted for the device by Web Push):
 * - `show`: show (or replace, by `tag`) a notification;
 * - `withdraw`: close the notifications with these tags, they are no
 *   longer current (e.g. the approval was answered elsewhere).
 * `badge`: number of sessions waiting for the user, for the app icon.
 */
export type PushPayload =
  | {
      type: 'show';
      tag: string;
      title: string;
      body: string;
      /** Path in the app to open on a tap, e.g. `/sessions/<id>`. */
      url: string;
      sessionId: string | null;
      /** Set on approval notifications: the request the actions answer. */
      requestId: string | null;
      actions: ApprovalAction[];
      /** Alert again although a notification with this tag is shown. */
      renotify: boolean;
      badge: number | null;
      /** When the event happened (ms since the epoch). */
      timestamp: number;
    }
  | { type: 'withdraw'; tags: string[]; badge: number | null };
