import type { SessionEvent } from '@claude-remote-manager/shared-types';

/**
 * The prompt suggestion that applies after `event`: Claude Code's latest
 * guess at the next message, until the user sends (or queues) one or a
 * turn starts.
 */
export function applySuggestion(
  current: string | null,
  event: SessionEvent,
): string | null {
  switch (event.type) {
    case 'prompt.suggestion':
      return event.text;
    case 'user.message':
    case 'message.queued':
      return null;
    case 'session.status':
      // A turn Claude Code started on its own makes the guess stale too.
      return event.status === 'running' ? null : current;
    default:
      return current;
  }
}
