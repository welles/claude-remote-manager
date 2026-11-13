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
import {
  formatTime,
  isStale,
  limitViews,
  type LimitView,
} from './limit-format';
import { LimitsStore } from './limits-store';

/**
 * The account's plan limits in the start page's app bar: the 5-hour window
 * as a small meter (amber from 75 %, red from 90 %), and all windows with
 * their reset times in a dialog. The one place the limits are shown.
 */
@Component({
  selector: 'app-limits-indicator',
  imports: [AppDialog, MatButtonModule],
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
      <div class="details" data-testid="limits-details">
        @for (view of views(); track view.type) {
          <div class="window" data-testid="limit">
            <div class="row">
              <span class="label">{{ view.label }}</span>
              <span class="percent level-{{ view.level }}">{{
                view.percentText
              }}</span>
            </div>
            <div
              class="bar"
              role="progressbar"
              [attr.aria-label]="view.label"
              [attr.aria-valuenow]="view.percent"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div
                class="fill level-{{ view.level }}"
                [style.width.%]="view.percent ?? 0"
              ></div>
            </div>
            <span class="reset" [class.old]="view.resetPassed">{{
              view.resetText
            }}</span>
          </div>
        } @empty {
          <p class="hint">
            Not known yet: Claude Code reports the limits with the first answer
            of a session (or when they are read on request).
          </p>
        }
        <!-- prettier-ignore -->
        <p class="hint" [class.warn]="stale()">@if (failed()) {Could not load the limits.} @else if (updated()) {Last updated {{ updated() }}{{ stale() ? ' (may be outdated)' : '' }}.} @else {Never updated.}</p>
      </div>
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
      cursor: pointer;
      white-space: nowrap;
    }
    .pill:hover {
      background: var(--mat-sys-surface-container-high);
    }
    .pill.level-warning {
      border-color: transparent;
      background: var(--app-status-attention-container);
      color: var(--app-status-on-attention-container);
    }
    .pill.level-critical {
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
    .meter .fill {
      position: absolute;
      inset: 0 auto 0 0;
      background: currentColor;
    }
    .old {
      text-decoration: line-through;
    }
    .details {
      display: flex;
      flex-direction: column;
      gap: var(--app-space-3);
    }
    .window {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      gap: var(--app-space-2);
      font: var(--mat-sys-title-small);
    }
    .percent {
      font-variant-numeric: tabular-nums;
    }
    .bar {
      height: 6px;
      border-radius: 3px;
      background: var(--mat-sys-surface-container-highest);
      overflow: hidden;
    }
    .bar .fill {
      height: 100%;
      background: var(--app-status-running);
    }
    .bar .fill.level-warning {
      background: var(--app-status-attention);
    }
    .bar .fill.level-critical {
      background: var(--mat-sys-error);
    }
    .percent.level-warning {
      color: var(--app-status-attention);
    }
    .percent.level-critical {
      color: var(--mat-sys-error);
    }
    .reset,
    .hint {
      margin: 0;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .warn {
      color: var(--mat-sys-error);
    }
  `,
})
export class LimitsIndicator implements OnInit {
  private readonly store = inject(LimitsStore);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly now = signal(Date.now());
  protected readonly limits = this.store.limits;
  protected readonly failed = this.store.failed;
  protected readonly views = computed(() => {
    const limits = this.limits();
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
    const limits = this.limits();
    return limits !== null && isStale(limits, this.now());
  });
  protected readonly updated = computed(() => {
    const at = this.limits()?.updatedAt;
    return at ? formatTime(at, this.now()) : null;
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
