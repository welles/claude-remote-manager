import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import type { AccountLimits } from '@claude-remote-manager/shared-types';
import { SessionSocket } from '../sessions/session-socket';

/** How often the limits are requested again (the server re-reads stale ones). */
export const LIMITS_POLL_MS = 5 * 60_000;

/**
 * The account's plan limits for the whole app: loaded once, then updated
 * live through `account.limits` frames and re-requested every few minutes
 * (which makes the server read them again when they are stale).
 */
@Injectable({ providedIn: 'root' })
export class LimitsStore {
  private readonly http = inject(HttpClient);
  private readonly socket = inject(SessionSocket);
  private started = false;

  /** `null` until loaded. */
  readonly limits = signal<AccountLimits | null>(null);
  readonly failed = signal(false);

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.socket.connect();
    this.socket.messages$.subscribe((message) => {
      if (message.type === 'account.limits') {
        this.limits.set(message.limits);
      }
    });
    this.load();
    setInterval(() => this.load(), LIMITS_POLL_MS);
  }

  load(): void {
    this.http.get<AccountLimits>('/api/limits').subscribe({
      next: (limits) => {
        this.failed.set(false);
        this.limits.set(limits);
      },
      error: () => this.failed.set(true),
    });
  }
}
