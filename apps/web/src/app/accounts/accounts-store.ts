import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import type { Observable } from 'rxjs';
import {
  MAIN_ACCOUNT_ID,
  type AccountDto,
  type AccountListResponse,
  type UpdateAccountRequest,
} from '@claude-remote-manager/shared-types';
import { SessionSocket } from '../sessions/session-socket';

/**
 * The Claude accounts for the whole app: loaded once, then updated live
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

  /** The default account's ID (the main one until loaded). */
  readonly defaultId = computed(
    () =>
      this.accounts()?.find((account) => account.isDefault)?.id ??
      MAIN_ACCOUNT_ID,
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

  /** The account a session uses (`null`: the default). */
  effective(accountId: string | null | undefined): AccountDto | null {
    const accounts = this.accounts() ?? [];
    return (
      accounts.find((account) => account.id === accountId) ??
      accounts.find((account) => account.id === this.defaultId()) ??
      null
    );
  }

  create(name: string): Observable<AccountDto> {
    return this.http.post<AccountDto>('/api/accounts', { name });
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
