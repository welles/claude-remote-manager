import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import type { Observable } from 'rxjs';
import {
  MAIN_ACCOUNT_ID,
  type AccountDto,
  type AccountListResponse,
  type AccountProvider,
  type UpdateAccountRequest,
} from '@claude-remote-manager/shared-types';
import { SessionSocket } from '../sessions/session-socket';

/**
 * The accounts of every provider for the whole app: loaded once, then updated live
 * through `accounts.changed` frames (logins, limits, edits).
 */
@Injectable({ providedIn: 'root' })
export class AccountsStore {
  private readonly http = inject(HttpClient);
  private readonly socket = inject(SessionSocket);
  private started = false;

  /** In order; `null` until loaded. */
  readonly accounts = signal<AccountDto[] | null>(null);
  readonly failed = signal(false);

  /** The default Claude account's ID (the main one until loaded). */
  readonly defaultId = computed(
    () => this.defaultOf('claude')?.id ?? MAIN_ACCOUNT_ID,
  );

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.socket.connect();
    this.socket.messages$.subscribe((message) => {
      if (message.type === 'accounts.changed') {
        this.accounts.set(message.accounts);
      }
    });
    this.load();
  }

  load(): void {
    this.http.get<AccountListResponse>('/api/accounts').subscribe({
      next: (response) => {
        this.failed.set(false);
        this.accounts.set(response.accounts);
      },
      error: () => this.failed.set(true),
    });
  }

  /** The accounts of a provider, in order. */
  ofProvider(provider: AccountProvider): AccountDto[] {
    return (this.accounts() ?? []).filter(
      (account) => account.provider === provider,
    );
  }

  /**
   * A provider's default account (each provider has its own; for Claude
   * the main one when none is marked), `null` while it has none.
   */
  defaultOf(provider: AccountProvider): AccountDto | null {
    const own = this.ofProvider(provider);
    return (
      own.find((account) => account.isDefault) ??
      own.find((account) => account.main) ??
      own[0] ??
      null
    );
  }

  /**
   * The account a session uses: its own (of the provider), else the
   * provider's default (`null` for the account means the default).
   */
  effective(
    accountId: string | null | undefined,
    provider: AccountProvider = 'claude',
  ): AccountDto | null {
    return (
      this.ofProvider(provider).find((account) => account.id === accountId) ??
      this.defaultOf(provider)
    );
  }

  create(provider: AccountProvider, name: string): Observable<AccountDto> {
    return this.http.post<AccountDto>('/api/accounts', { provider, name });
  }

  update(id: string, request: UpdateAccountRequest): Observable<AccountDto> {
    return this.http.patch<AccountDto>(`/api/accounts/${id}`, request);
  }

  reorder(ids: string[]): Observable<AccountListResponse> {
    return this.http.put<AccountListResponse>('/api/accounts/order', { ids });
  }

  remove(id: string): Observable<void> {
    return this.http.delete<void>(`/api/accounts/${id}`);
  }

  startLogin(id: string): Observable<AccountDto> {
    return this.http.post<AccountDto>(`/api/accounts/${id}/login`, {});
  }

  submitCode(id: string, code: string): Observable<AccountDto> {
    return this.http.post<AccountDto>(`/api/accounts/${id}/login/code`, {
      code,
    });
  }

  cancelLogin(id: string): Observable<void> {
    return this.http.delete<void>(`/api/accounts/${id}/login`);
  }

  logout(id: string): Observable<AccountDto> {
    return this.http.post<AccountDto>(`/api/accounts/${id}/logout`, {});
  }

  refresh(id: string): Observable<AccountDto> {
    return this.http.post<AccountDto>(`/api/accounts/${id}/refresh`, {});
  }
}
