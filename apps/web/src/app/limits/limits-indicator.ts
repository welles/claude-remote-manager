import {
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
  ACCOUNT_PROVIDER_LABELS,
  type AccountProvider,
} from '@claude-remote-manager/shared-types';
import { AppDialog } from '../ui/dialog';
import { Meter } from '../ui/meter';
import { isStale, limitViews, type LimitView } from './limit-format';
import { LimitWindows } from './limit-windows';
import { AccountsStore } from '../accounts/accounts-store';
import { EnginesStore } from '../engines/engines-store';
import { LimitsStore } from './limits-store';

/** One provider's default account on the button. */
interface Headline {
  provider: AccountProvider;
  /** The provider's name, when several are shown. */
  name: string | null;
  /** The window on the button: 5 hours (or the first one). */
  view: LimitView | null;
  stale: boolean;
  label: string;
}

/**
 * The plan limits in the start page's app bar: the default account's
 * 5-hour window of each provider whose engine the server has and that has
 * accounts (side by side, named only when there are several) as a small
 * meter, neutral until 75 %, then outlined in the error colour, filled
 * when exhausted (amber stays reserved for sessions that need the user);
 * all windows of every account with their reset times in a dialog.
 */
@Component({
  selector: 'app-limits-indicator',
  imports: [AppDialog, LimitWindows, MatButtonModule, Meter],
  template: `
    @for (entry of headlines(); track entry.provider) {
      @let view = entry.view;
      <button
        type="button"
        class="chip"
        [class]="
          view?.level === 'exhausted'
            ? 'tone-error'
            : view?.level === 'high'
              ? 'tone-error-line'
              : ''
        "
        [class.ml-1.5]="!$first"
        (click)="details.open()"
        [attr.aria-label]="entry.label"
        data-testid="limits"
      >
        @if (entry.name) {
          <span class="font-medium">{{ entry.name }}</span>
        }
        @if (view) {
          <app-meter
            inline
            [value]="view.percent"
            [high]="view.level !== 'normal'"
          />
          <span
            [class.opacity-70]="entry.stale"
            [class.line-through]="view.resetPassed"
            >{{ view.short }} {{ view.percentText }}</span
          >
        } @else {
          Limits ?
        }
      </button>
    }
    <app-dialog #details heading="Plan limits">
      @let list = accounts();
      @if (list.length > 1) {
        <div class="flex flex-col gap-5">
          @for (account of list; track account.id) {
            <section class="flex flex-col gap-2" data-testid="limits-account">
              <h3 class="type-title-small m-0">
                {{ account.name }}
                @if (headlines().length > 1) {
                  <span class="badge">{{
                    providerLabels[account.provider]
                  }}</span>
                }
                @if (account.isDefault) {
                  <span class="badge">default</span>
                }
              </h3>
              <app-limit-windows [accountId]="account.id" />
            </section>
          }
        </div>
      } @else {
        <app-limit-windows />
      }
      <div dialog-actions>
        <button
          matButton
          type="button"
          (click)="refresh()"
          data-testid="limits-refresh"
        >
          Refresh
        </button>
      </div>
    </app-dialog>
  `,
})
export class LimitsIndicator implements OnInit {
  private readonly store = inject(LimitsStore);
  private readonly accountsStore = inject(AccountsStore);
  private readonly enginesStore = inject(EnginesStore);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly providerLabels = ACCOUNT_PROVIDER_LABELS;
  protected readonly now = signal(Date.now());
  protected readonly accounts = computed(
    () => this.accountsStore.accounts() ?? [],
  );
  /**
   * The providers shown: those of the server's engines that have accounts
   * (Claude alone until the accounts are known).
   */
  private readonly providers = computed<AccountProvider[]>(() => {
    const shown = this.enginesStore
      .providers()
      .filter((provider) => this.accountsStore.ofProvider(provider).length);
    return shown.length > 0 ? shown : ['claude'];
  });
  protected readonly headlines = computed<Headline[]>(() => {
    const providers = this.providers();
    const several = providers.length > 1;
    return providers.map((provider) => {
      const accountId =
        provider === 'claude'
          ? this.accountsStore.defaultId()
          : (this.accountsStore.defaultOf(provider)?.id ?? '');
      const limits = this.store.limits(accountId);
      const view = limits ? (limitViews(limits, this.now())[0] ?? null) : null;
      const name = several ? ACCOUNT_PROVIDER_LABELS[provider] : null;
      const prefix = name ? `${name} plan limits` : 'Plan limits';
      return {
        provider,
        name,
        view,
        stale: limits !== null && isStale(limits, this.now()),
        label: view
          ? `${prefix}: ${view.label} ${view.percentText}, ${view.resetText}`
          : prefix,
      };
    });
  });

  ngOnInit(): void {
    this.store.start();
    this.accountsStore.start();
    this.enginesStore.load();
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  protected refresh(): void {
    this.store.load();
  }
}
