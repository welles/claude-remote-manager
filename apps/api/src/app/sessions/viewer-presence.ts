import { Injectable } from '@nestjs/common';
import { PRESENCE_TIMEOUT_MS } from '@claude-remote-manager/shared-types';

interface Presence {
  sessionId: string | null;
  active: boolean;
  at: number;
}

/**
 * Which sessions a user is looking at right now, from the `presence`
 * frames of the WebSocket clients. Notifications about such a session are
 * skipped. A subscription alone is no proof: a phone in a pocket keeps its
 * connection for a while. A client counts only while it says it is active
 * (visible, focused, used recently) and repeats that within
 * {@link PRESENCE_TIMEOUT_MS}; it stops counting when it says otherwise or
 * disconnects.
 */
@Injectable()
export class ViewerPresence {
  private readonly clients = new Map<object, Presence>();

  constructor(private readonly now: () => number = Date.now) {}

  update(client: object, sessionId: string | null, active: boolean): void {
    this.clients.set(client, { sessionId, active, at: this.now() });
  }

  remove(client: object): void {
    this.clients.delete(client);
  }

  /** Whether an active client shows this session. */
  isViewed(sessionId: string): boolean {
    const limit = this.now() - PRESENCE_TIMEOUT_MS;
    for (const presence of this.clients.values()) {
      if (
        presence.active &&
        presence.sessionId === sessionId &&
        presence.at >= limit
      ) {
        return true;
      }
    }
    return false;
  }
}
