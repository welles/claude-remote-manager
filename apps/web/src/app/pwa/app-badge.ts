import { Injectable, inject } from '@angular/core';
import {
  needsUser,
  type SessionDto,
} from '@claude-remote-manager/shared-types';
import { SessionSocket } from '../sessions/session-socket';
import { SessionsApi } from '../sessions/sessions-api';
import { NeedsYouCount } from './needs-you';

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/** Sessions blocked on the user (see `needsUser`): the badge's number. */
export function needsUserCount(sessions: Iterable<SessionDto>): number {
  let count = 0;
  for (const session of sessions) {
    if (needsUser(session)) {
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
 * Keeps the number of sessions blocked on the user (open approval,
 * question, plan, or failed setup) current while the app is open: for the
 * navigation's badge and, in the installed app, the icon's badge (push
 * messages update that one while the app is closed).
 */
@Injectable({ providedIn: 'root' })
export class AppBadge {
  private readonly api = inject(SessionsApi);
  private readonly socket = inject(SessionSocket);
  private readonly needsYou = inject(NeedsYouCount);
  private readonly sessions = new Map<string, SessionDto>();
  private started = false;

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.socket.messages$.subscribe((message) => {
      if (message.type === 'session.updated') {
        this.sessions.set(message.session.id, message.session);
        this.publish();
      } else if (message.type === 'session.deleted') {
        this.sessions.delete(message.sessionId);
        this.publish();
      }
    });
    this.api.list().subscribe({
      next: ({ sessions }) => {
        for (const session of sessions) {
          if (!this.sessions.has(session.id)) {
            this.sessions.set(session.id, session);
          }
        }
        this.publish();
      },
      error: () => undefined,
    });
  }

  private publish(): void {
    const count = needsUserCount(this.sessions.values());
    this.needsYou.count.set(count);
    if ('setAppBadge' in navigator) {
      setBadge(count);
    }
  }
}
