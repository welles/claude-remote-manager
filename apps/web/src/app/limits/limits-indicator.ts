import {
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { AppDialog } from '../ui/dialog';
import { isStale, limitViews, type LimitView } from './limit-format';
import { LimitWindows } from './limit-windows';
import { LimitsStore } from './limits-store';

/**
 * The account's plan limits in the start page's app bar: the 5-hour window
 * as a small meter, neutral until 75 %, then outlined in the error colour,
 * filled when exhausted (amber stays reserved for sessions that need the
 * user); all windows with their reset times in a dialog.
 */
@Component({
  selector: 'app-limits-indicator',
  imports: [AppDialog, LimitWindows, MatButtonModule],
  template: `
    <button
      type="button"
      class="pill level-{{ headline()?.level ?? 'normal' }}"
      [class.stale]="stale()"
      (click)="details.open()"
      [attr.aria-label]="label()"
      data-testid="limits"
    >
      @if (headline(); as view) {
        <span class="meter" aria-hidden="true"
          ><span class="fill" [style.width.%]="view.percent ?? 0"></span
        ></span>
        <span class="value" [class.old]="view.resetPassed"
          >{{ view.short }} {{ view.percentText }}</span
        >
      } @else {
        <span class="value">Limits ?</span>
      }
    </button>
    <app-dialog #details heading="Plan limits (whole account)">
      <app-limit-windows />
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
  styles: `
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 30px;
      padding: 0 10px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-small);
      background: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      white-space: nowrap;
    }
    .pill:hover {
      background: var(--mat-sys-surface-container-high);
    }
    .pill.level-high {
      border-color: var(--mat-sys-error);
      color: var(--mat-sys-error);
    }
    .pill.level-exhausted {
      border-color: transparent;
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }
    .pill.stale .value {
      opacity: 0.7;
    }
    .meter {
      position: relative;
      width: 28px;
      height: 4px;
      border-radius: 2px;
      background: color-mix(in srgb, currentColor 25%, transparent);
      overflow: hidden;
    }
    .fill {
      position: absolute;
      inset: 0 auto 0 0;
      background: currentColor;
    }
    .old {
      text-decoration: line-through;
    }
  `,
})
export class LimitsIndicator implements OnInit {
  private readonly store = inject(LimitsStore);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly now = signal(Date.now());
  protected readonly views = computed(() => {
    const limits = this.store.limits();
    return limits ? limitViews(limits, this.now()) : [];
  });
  /** The window on the button: 5 hours (or the first one). */
  protected readonly headline = computed<LimitView | null>(
    () => this.views()[0] ?? null,
  );
  protected readonly label = computed(() => {
    const view = this.headline();
    return view
      ? `Plan limits: ${view.label} ${view.percentText}, ${view.resetText}`
      : 'Plan limits';
  });
  protected readonly stale = computed(() => {
    const limits = this.store.limits();
    return limits !== null && isStale(limits, this.now());
  });

  ngOnInit(): void {
    this.store.start();
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  protected refresh(): void {
    this.store.load();
  }
}
