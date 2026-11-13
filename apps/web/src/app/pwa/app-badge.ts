import { Injectable, inject } from '@angular/core';
import type { SessionDto } from '@claude-remote-manager/shared-types';
import { SessionSocket } from '../sessions/session-socket';
import { SessionsApi } from '../sessions/sessions-api';

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/** Sessions that wait for the user (any `waiting`: message, approval, setup). */
export function waitingCount(sessions: Iterable<SessionDto>): number {
  let count = 0;
  for (const session of sessions) {
    if (session.status === 'waiting') {
      count++;
    }
  }
  return count;
}

/** Sets the app icon's badge (Badging API, installed app only). */
export function setBadge(
  count: number,
  target: BadgeNavigator = navigator as BadgeNavigator,
): void {
  const result =
    count > 0 ? target.setAppBadge?.(count) : target.clearAppBadge?.();
  result?.catch(() => undefined);
}

/**
 * Keeps the app icon's badge at the number of sessions waiting for the
 * user while the app is open; push messages update it while it is closed.
 */
@Injectable({ providedIn: 'root' })
export class AppBadge {
  private readonly api = inject(SessionsApi);
  private readonly socket = inject(SessionSocket);
  private readonly sessions = new Map<string, SessionDto>();
  private started = false;

  start(): void {
    if (this.started || !('setAppBadge' in navigator)) {
      return;
    }
    this.started = true;
    this.socket.messages$.subscribe((message) => {
      if (message.type === 'session.updated') {
        this.sessions.set(message.session.id, message.session);
        setBadge(waitingCount(this.sessions.values()));
      }
    });
    this.api.list().subscribe({
      next: ({ sessions }) => {
        for (const session of sessions) {
          if (!this.sessions.has(session.id)) {
            this.sessions.set(session.id, session);
          }
        }
        setBadge(waitingCount(this.sessions.values()));
      },
      error: () => undefined,
    });
  }
}
