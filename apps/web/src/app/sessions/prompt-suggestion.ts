import type { SessionEvent } from '@claude-remote-manager/shared-types';

/**
 * The prompt suggestion that applies after `event`: Claude Code's latest
 * guess at the next message, until the user sends (or queues) one.
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
    default:
      return current;
  }
}
