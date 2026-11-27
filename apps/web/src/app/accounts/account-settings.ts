import {
  Component,
  computed,
  inject,
  signal,
  viewChild,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { Observable } from 'rxjs';
import {
  ACCOUNT_PROVIDER_LABELS,
  ACCOUNT_PROVIDERS,
  MAX_ACCOUNT_NAME_LENGTH,
  type AccountDto,
  type AccountProvider,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { LimitWindows } from '../limits/limit-windows';
import { LimitsStore } from '../limits/limits-store';
import { AppDialog } from '../ui/dialog';
import { Toasts } from '../ui/toasts';
import { AccountsStore } from './accounts-store';

/** "Max (5x)", "Pro"; `null` when unknown. */
export function planLabel(account: AccountDto): string | null {
  const type = account.subscriptionType;
  return type ? type.charAt(0).toUpperCase() + type.slice(1) : null;
}

/**
 * The accounts of every provider on the Settings page: their login state and limits,
 * adding one with the login in the UI (open the login page, paste the
 * code), logging in again or out, renaming, the default and the order of
 * the automatic switch, removing.
 */
@Component({
  selector: 'app-account-settings',
  host: { class: 'flex flex-col gap-4' },
  imports: [
    AppDialog,
    FormsModule,
    LimitWindows,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  template: `
    <p class="m-0 text-on-surface-variant">
      Sessions work with a subscription account. New sessions use the default
      account, or the next one in this order while its limit is used up; each
      session can switch its account in its settings. Accounts of the same
      provider share settings, skills, plugins, memory and conversations.
    </p>
    @if (store.failed()) {
      <p class="m-0 text-error">The accounts could not be loaded.</p>
      <button matButton type="button" (click)="store.load()">Retry</button>
    }
    @for (
      account of accounts();
      track account.id;
      let first = $first;
      let last = $last
    ) {
      <section
        class="flex flex-col gap-2 rounded-md border border-outline-variant p-3"
        data-testid="account"
      >
        <div class="flex flex-wrap items-baseline gap-2">
          <h3
            class="type-title-medium m-0 wrap-anywhere"
            data-testid="account-name"
          >
            {{ account.name }}
          </h3>
          <span class="badge" data-testid="account-provider">{{
            providerLabels[account.provider]
          }}</span>
          @if (account.isDefault) {
            <span class="badge" data-testid="account-default">default</span>
          }
          @if (account.loggedIn === false) {
            <span class="badge tone-error" data-testid="account-logged-out"
              >logged out</span
            >
          }
        </div>
        @if (account.loggedIn) {
          <p
            class="m-0 text-on-surface-variant wrap-anywhere"
            data-testid="account-login"
          >
            {{ account.email ?? 'Logged in' }}
            @if (planLabel(account); as plan) {
              · {{ plan }}
            }
            @if (account.organization) {
              · {{ account.organization }}
            }
          </p>
        }
        @if (account.login; as login) {
          <div class="flex flex-col gap-2" data-testid="account-login-flow">
            @switch (login.status) {
              @case ('starting') {
                <p class="m-0">Starting the login …</p>
              }
              @case ('waiting') {
                <p class="m-0">
                  Open the login page, sign in with the Claude account and paste
                  the code shown there.
                </p>
                <div class="flex flex-wrap items-center gap-2">
                  <a
                    matButton="tonal"
                    [href]="login.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="account-login-url"
                    >Open login page</a
                  >
                </div>
                <form
                  class="flex flex-wrap items-center gap-2"
                  (ngSubmit)="submitCode(account)"
                >
                  <mat-form-field
                    appearance="outline"
                    subscriptSizing="dynamic"
                    class="min-w-0 flex-[1_1_240px]"
                  >
                    <mat-label>Code</mat-label>
                    <input
                      matInput
                      name="code"
                      autocomplete="off"
                      [(ngModel)]="codes[account.id]"
                      data-testid="account-login-code"
                    />
                  </mat-form-field>
                  <button
                    matButton="filled"
                    type="submit"
                    [disabled]="!codes[account.id]?.trim() || busy()"
                    data-testid="account-login-submit"
                  >
                    Log in
                  </button>
                </form>
              }
              @case ('verifying') {
                <p class="m-0">Checking the code …</p>
              }
              @case ('done') {
                <p
                  class="m-0 text-on-surface-variant"
                  data-testid="account-login-done"
                >
                  Logged in.
                </p>
              }
              @case ('failed') {
                <p
                  class="m-0 text-error wrap-anywhere"
                  data-testid="account-login-error"
                >
                  The login failed{{ login.error ? ': ' + login.error : '.' }}
                </p>
              }
            }
          </div>
        }
        @if (account.loggedIn) {
          <details>
            <summary class="cursor-pointer text-on-surface-variant">
              Plan limits
            </summary>
            <div class="pt-2">
              <app-limit-windows [accountId]="account.id" />
            </div>
          </details>
        }
        <div class="flex flex-wrap gap-1">
          @if (
            account.login?.status === 'starting' ||
            account.login?.status === 'waiting' ||
            account.login?.status === 'verifying'
          ) {
            <button
              matButton
              type="button"
              (click)="
                run(
                  store.cancelLogin(account.id),
                  'The login could not be cancelled'
                )
              "
              data-testid="account-login-cancel"
            >
              Cancel login
            </button>
          } @else {
            <button
              matButton
              type="button"
              (click)="
                run(
                  store.startLogin(account.id),
                  'The login could not be started'
                )
              "
              data-testid="account-login-start"
            >
              {{ account.loggedIn ? 'Log in again' : 'Log in' }}
            </button>
          }
          @if (account.loggedIn) {
            <button
              matButton
              type="button"
              (click)="logout(account)"
              data-testid="account-logout"
            >
              Log out
            </button>
          }
          @if (!account.isDefault) {
            <button
              matButton
              type="button"
              (click)="
                run(
                  store.update(account.id, { isDefault: true }),
                  'The default could not be changed'
                )
              "
              data-testid="account-make-default"
            >
              Make default
            </button>
          }
          <button
            matButton
            type="button"
            (click)="openRename(account)"
            data-testid="account-rename"
          >
            Rename
          </button>
          @if (!first) {
            <button
              matButton
              type="button"
              (click)="move(account, -1)"
              data-testid="account-up"
            >
              Move up
            </button>
          }
          @if (!last) {
            <button
              matButton
              type="button"
              (click)="move(account, 1)"
              data-testid="account-down"
            >
              Move down
            </button>
          }
          @if (!account.main) {
            <button
              matButton
              type="button"
              class="text-error"
              (click)="remove(account)"
              data-testid="account-remove"
            >
              Remove
            </button>
          }
        </div>
      </section>
    }
    <div class="flex flex-wrap gap-2">
      @for (provider of providers; track provider) {
        <button
          matButton="tonal"
          type="button"
          (click)="openAdd(provider)"
          [attr.data-testid]="'account-add-' + provider"
        >
          Add {{ providerLabels[provider] }} account
        </button>
      }

      <app-dialog
        #nameDialog
        [heading]="
          renaming()
            ? 'Rename account'
            : 'Add ' + providerLabels[adding()] + ' account'
        "
        initialFocus="input"
        testId="account-name-dialog"
      >
        <form id="account-name-form" (ngSubmit)="saveName()">
          <mat-form-field appearance="outline" class="w-full">
            <mat-label>Name</mat-label>
            <input
              matInput
              name="name"
              [maxlength]="maxNameLength"
              [(ngModel)]="name"
              data-testid="account-name-input"
            />
            @if (!renaming()) {
              <mat-hint>e.g. "Work" or "Private"; the login follows.</mat-hint>
            }
          </mat-form-field>
        </form>
        <div dialog-actions>
          <button matButton type="button" (click)="nameDialog.close()">
            Cancel
          </button>
          <button
            matButton="filled"
            type="submit"
            form="account-name-form"
            [disabled]="!name.trim() || busy()"
            data-testid="account-name-save"
          >
            {{ renaming() ? 'Save' : 'Add and log in' }}
          </button>
        </div>
      </app-dialog>

      <app-dialog
        #confirmDialog
        [heading]="
          confirming()?.action === 'remove' ? 'Remove account?' : 'Log out?'
        "
        testId="account-confirm-dialog"
      >
        @if (confirming(); as c) {
          <p class="m-0">
            @if (c.action === 'remove') {
              {{ c.account.name }} is logged out and removed. Its sessions
              continue with the default account.
            } @else {
              {{ c.account.name }} is logged out. Its sessions cannot continue
              until it is logged in again.
            }
          </p>
        }
        <div dialog-actions>
          <button matButton type="button" (click)="confirmDialog.close()">
            Cancel
          </button>
          <button
            matButton="filled"
            type="button"
            [disabled]="busy()"
            (click)="confirmed()"
            data-testid="account-confirm"
          >
            {{ confirming()?.action === 'remove' ? 'Remove' : 'Log out' }}
          </button>
        </div>
      </app-dialog>
    </div>
  `,
})
export class AccountSettings implements OnInit {
  protected readonly store = inject(AccountsStore);
  private readonly limits = inject(LimitsStore);
  private readonly toasts = inject(Toasts);

  protected readonly accounts = computed(() => this.store.accounts() ?? []);
  protected readonly busy = signal(false);
  protected readonly renaming = signal<AccountDto | null>(null);
  protected readonly maxNameLength = MAX_ACCOUNT_NAME_LENGTH;
  protected readonly planLabel = planLabel;
  protected readonly providers = ACCOUNT_PROVIDERS;
  protected readonly providerLabels = ACCOUNT_PROVIDER_LABELS;
  /** The provider of the account being added. */
  protected readonly adding = signal<AccountProvider>('claude');
  protected name = '';
  /** Codes typed per account. */
  protected codes: Record<string, string> = {};

  private readonly nameDialog = viewChild.required<AppDialog>('nameDialog');
  private readonly confirmDialog =
    viewChild.required<AppDialog>('confirmDialog');
  protected readonly confirming = signal<{
    account: AccountDto;
    action: 'logout' | 'remove';
  } | null>(null);

  ngOnInit(): void {
    this.store.start();
    this.limits.start();
  }

  protected openAdd(provider: AccountProvider): void {
    this.adding.set(provider);
    this.renaming.set(null);
    this.name = '';
    this.nameDialog().open();
  }

  protected openRename(account: AccountDto): void {
    this.renaming.set(account);
    this.name = account.name;
    this.nameDialog().open();
  }

  protected saveName(): void {
    const name = this.name.trim();
    if (!name || this.busy()) {
      return;
    }
    const renaming = this.renaming();
    this.run(
      renaming
        ? this.store.update(renaming.id, { name })
        : this.store.create(this.adding(), name),
      renaming
        ? 'The account could not be renamed'
        : 'The account could not be added',
      () => this.nameDialog().close(),
    );
  }

  protected submitCode(account: AccountDto): void {
    const code = this.codes[account.id]?.trim();
    if (!code) {
      return;
    }
    this.run(
      this.store.submitCode(account.id, code),
      'The code could not be sent',
      () => {
        delete this.codes[account.id];
      },
    );
  }

  protected logout(account: AccountDto): void {
    this.confirming.set({ account, action: 'logout' });
    this.confirmDialog().open();
  }

  protected remove(account: AccountDto): void {
    this.confirming.set({ account, action: 'remove' });
    this.confirmDialog().open();
  }

  protected confirmed(): void {
    const confirming = this.confirming();
    if (!confirming) {
      return;
    }
    const { account, action } = confirming;
    this.run(
      action === 'logout'
        ? this.store.logout(account.id)
        : this.store.remove(account.id),
      action === 'logout'
        ? 'The logout failed'
        : 'The account could not be removed',
      () => this.confirmDialog().close(),
    );
  }

  protected move(account: AccountDto, by: -1 | 1): void {
    const ids = this.accounts().map((entry) => entry.id);
    const index = ids.indexOf(account.id);
    const target = index + by;
    if (index < 0 || target < 0 || target >= ids.length) {
      return;
    }
    [ids[index], ids[target]] = [ids[target], ids[index]];
    this.run(this.store.reorder(ids), 'The order could not be changed');
  }

  /** Runs a request; the store follows the server's `accounts.changed`. */
  protected run(
    request: Observable<unknown>,
    failure: string,
    done?: () => void,
  ): void {
    this.busy.set(true);
    request.subscribe({
      next: () => {
        this.busy.set(false);
        done?.();
        // Also without the WebSocket (e.g. reconnecting).
        this.store.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        // What did happen shows (e.g. a logout before a failed removal).
        this.store.load();
        this.toasts.show({
          title: errorMessage(error, failure),
          kind: 'error',
        });
      },
    });
  }
}
