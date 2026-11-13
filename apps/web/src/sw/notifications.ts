import type {
  ApprovalAction,
  ApprovalActionResult,
  PushPayload,
} from '@claude-remote-manager/shared-types';

/**
 * Notification logic of the service worker, without service worker
 * globals so that it can be tested (see worker.ts for the wiring).
 */

/** What a shown notification keeps for its click handler. */
export interface NotificationData {
  url: string;
  sessionId: string | null;
  requestId: string | null;
}

/** The options of `showNotification` this app uses. */
export interface ShowOptions {
  body: string;
  tag: string;
  renotify: boolean;
  silent: boolean;
  requireInteraction: boolean;
  timestamp: number;
  icon: string;
  badge: string;
  data: NotificationData;
  actions: { action: string; title: string }[];
}

export const ICON = '/icons/icon-192.png';
export const BADGE = '/icons/badge-96.png';

const ACTION_TITLES: Record<ApprovalAction, string> = {
  allow: 'Allow once',
  deny: 'Deny',
};

/** The push message, or `null` if it is not one of this app's. */
export function parsePayload(text: string | null): PushPayload | null {
  if (!text) {
    return null;
  }
  try {
    const payload = JSON.parse(text) as PushPayload;
    if (payload?.type === 'show' && typeof payload.title === 'string') {
      return payload;
    }
    if (payload?.type === 'withdraw' && Array.isArray(payload.tags)) {
      return payload;
    }
  } catch {
    // Not JSON.
  }
  return null;
}

/** Title and options of the notification for a `show` message. */
export function notificationFor(
  payload: Extract<PushPayload, { type: 'show' }>,
): { title: string; options: ShowOptions } {
  const actions = payload.requestId ? payload.actions : [];
  return {
    title: payload.title,
    options: {
      body: payload.body,
      tag: payload.tag,
      renotify: payload.renotify,
      silent: false,
      // Approvals stay until answered (where the platform supports it).
      requireInteraction: actions.length > 0,
      timestamp: payload.timestamp,
      icon: ICON,
      badge: BADGE,
      data: {
        url: safePath(payload.url),
        sessionId: payload.sessionId,
        requestId: payload.requestId,
      },
      actions: actions.map((action) => ({
        action,
        title: ACTION_TITLES[action],
      })),
    },
  };
}

/** Only paths of this app are opened, never other origins. */
export function safePath(url: string): string {
  return /^\/(?!\/)[^\\]*$/.test(url) ? url : '/';
}

/** Why an approval action did not get through. */
export type ActionFailure = 'signed_out' | 'offline' | 'refused' | 'error';

export type ActionOutcome =
  | { kind: 'done'; result: ApprovalActionResult }
  | { kind: 'failed'; failure: ActionFailure };

/** How long the button waits for the server before giving up. */
export const ACTION_TIMEOUT_MS = 6000;

/**
 * Sends the Allow or Deny of an approval notification as an ordinary
 * request of the app: with the browser's cookies (the Cloudflare Access
 * session), passing the API's authentication and request guard like every
 * other request. The notification carries no token. A redirect (to the
 * Access login) or a refusal means the answer was not given.
 */
export async function sendApprovalAction(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  data: NotificationData,
  action: ApprovalAction,
): Promise<ActionOutcome> {
  if (!data.sessionId || !data.requestId) {
    return { kind: 'failed', failure: 'error' };
  }
  let response: Response;
  try {
    response = await fetchFn('/api/notifications/approval-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: data.sessionId,
        requestId: data.requestId,
        action,
      }),
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'failed', failure: 'offline' };
  }
  if (response.type === 'opaqueredirect' || response.status === 401) {
    return { kind: 'failed', failure: 'signed_out' };
  }
  if (!response.ok) {
    return {
      kind: 'failed',
      failure: response.status === 403 ? 'signed_out' : 'refused',
    };
  }
  try {
    const result = (await response.json()) as ApprovalActionResult;
    if (
      result.outcome === 'applied' ||
      result.outcome === 'already_resolved' ||
      result.outcome === 'not_offered'
    ) {
      return { kind: 'done', result };
    }
  } catch {
    // An HTML page (e.g. a login page) instead of the API's answer.
  }
  return { kind: 'failed', failure: 'signed_out' };
}

/**
 * What the user sees after pressing a button: nothing when it worked (the
 * notification goes away), otherwise a notification that says what
 * happened; `open` when the session should open so that the user answers
 * there (the request is still pending).
 */
export function afterAction(
  outcome: ActionOutcome,
  action: ApprovalAction,
): { notice: { title: string; body: string } | null; open: boolean } {
  if (outcome.kind === 'done') {
    const { result } = outcome;
    if (result.outcome === 'applied') {
      return { notice: null, open: false };
    }
    if (result.outcome === 'already_resolved') {
      return {
        notice: {
          title: 'Already answered',
          body:
            result.decision === 'allow'
              ? 'This request had been allowed before; your answer was not used.'
              : 'This request had been denied or cancelled before; your answer was not used.',
        },
        open: false,
      };
    }
    return {
      notice: {
        title: 'Answer in the session',
        body: 'This request cannot be answered from a notification. It is still waiting.',
      },
      open: true,
    };
  }
  const reasons: Record<ActionFailure, string> = {
    signed_out: 'Your sign-in has expired.',
    offline: 'The server could not be reached.',
    refused: 'The server refused it.',
    error: 'Something went wrong.',
  };
  return {
    notice: {
      title: `Not ${action === 'allow' ? 'allowed' : 'denied'}: still waiting`,
      body: `${reasons[outcome.failure]} Open the session to answer the request.`,
    },
    open: true,
  };
}
