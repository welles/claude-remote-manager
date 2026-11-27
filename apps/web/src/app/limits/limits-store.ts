import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import type {
  AccountLimits,
  AccountLimitsListResponse,
} from '@claude-remote-manager/shared-types';
import { SessionSocket } from '../sessions/session-socket';

/** How often the limits are requested again (the server re-reads stale ones). */
export const LIMITS_POLL_MS = 5 * 60_000;

/**
 * The plan limits of every account for the whole app: loaded once, then
 * updated live through `account.limits` frames and re-requested every few
 * minutes (which makes the server read them again when they are stale).
 */
@Injectable({ providedIn: 'root' })
export class LimitsStore {
  private readonly http = inject(HttpClient);
  private readonly socket = inject(SessionSocket);
  private started = false;

  /** In the accounts' order; `null` until loaded. */
  readonly accounts = signal<AccountLimits[] | null>(null);
  readonly failed = signal(false);

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.socket.connect();
    this.socket.messages$.subscribe((message) => {
      if (message.type === 'accounts.changed') {
        // The accounts carry their limits: added and removed ones follow.
        this.accounts.set(message.accounts.map((account) => account.limits));
        return;
      }
      if (message.type === 'account.limits') {
        const limits = message.limits;
        // Only accounts the last list named: a removed one does not come
        // back.
        const current = this.accounts() ?? [];
        if (current.some((entry) => entry.accountId === limits.accountId)) {
          this.accounts.set(
            current.map((entry) =>
              entry.accountId === limits.accountId ? limits : entry,
            ),
          );
        }
      }
    });
    this.load();
    setInterval(() => this.load(), LIMITS_POLL_MS);
  }

  /** The limits of an account; `null` while unknown. */
  limits(accountId: string): AccountLimits | null {
    return (
      this.accounts()?.find((entry) => entry.accountId === accountId) ?? null
    );
  }

  load(): void {
    this.http.get<AccountLimitsListResponse>('/api/limits').subscribe({
      next: (response) => {
        this.failed.set(false);
        this.accounts.set(response.accounts);
      },
      error: () => this.failed.set(true),
    });
  }
}
