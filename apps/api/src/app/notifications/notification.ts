import { createHash } from 'node:crypto';
import type {
  ApprovalAction,
  NotificationEventType,
} from '@claude-remote-manager/shared-types';

/**
 * A notification as the channels send it. `key` identifies what it is about
 * (e.g. one approval request, or "the turn of session X ended"): a later
 * notification with the same key replaces it, and withdrawing the key
 * removes it where the channel allows that.
 */
export interface AppNotification {
  type: NotificationEventType;
  key: string;
  sessionId: string | null;
  title: string;
  body: string;
  /** Path in the web app to open, e.g. `/sessions/<id>`. */
  path: string;
  /** Approval notifications: the request the actions answer. */
  requestId: string | null;
  /** Buttons answering the request from the notification (Web Push only). */
  actions: ApprovalAction[];
  /** Needs the user soon (approvals): delivered with high priority. */
  urgent: boolean;
  /** When it happened (ms since the epoch). */
  at: number;
}

/** Keys of the notifications, see {@link AppNotification.key}. */
export const notificationKeys = {
  approval: (requestId: string) => `approval-${requestId}`,
  turn: (sessionId: string) => `turn-${sessionId}`,
  stall: (sessionId: string) => `stall-${sessionId}`,
  failed: (sessionId: string) => `failed-${sessionId}`,
  pullRequest: (pullRequestId: number) => `pr-${pullRequestId}`,
  automerge: (pullRequestId: number) => `automerge-${pullRequestId}`,
  mergeQueue: (pullRequestId: number) => `merge-queue-${pullRequestId}`,
};

/**
 * A short identifier derived from a key, for channels that limit them: the
 * Web Push `Topic` header (32 base64url characters) and ntfy sequence IDs.
 */
export function shortId(key: string): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 32);
}

/** Shortens a text to `max` characters on one line, with an ellipsis. */
export function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Keeps the start and the end of a long text (paths, commands). */
export function shortenMiddle(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) {
    return line;
  }
  const head = Math.ceil((max - 1) * 0.6);
  return `${line.slice(0, head)}…${line.slice(line.length - (max - 1 - head))}`;
}
