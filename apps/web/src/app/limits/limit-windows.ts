import {
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { formatTime, isStale, limitViews } from './limit-format';
import { LimitsStore } from './limits-store';

/**
 * The account's plan limit windows with percent, meter and reset time, and
 * when they were last read: in the limits dialog of the session list and
 * in the session's details.
 */
@Component({
  selector: 'app-limit-windows',
  template: `
    <div class="windows" data-testid="limits-details">
      @for (view of views(); track view.type) {
        <div class="window level-{{ view.level }}" data-testid="limit">
          <div class="row">
            <span class="label">{{ view.label }}</span>
            <span class="percent">{{ view.percentText }}</span>
          </div>
          <div
            class="bar"
            role="progressbar"
            [attr.aria-label]="view.label"
            [attr.aria-valuenow]="view.percent"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div class="fill" [style.width.%]="view.percent ?? 0"></div>
          </div>
          <span class="reset" [class.old]="view.resetPassed">{{
            view.resetText
          }}</span>
        </div>
      } @empty {
        <p class="hint">
          Not known yet: Claude Code reports the limits with the first answer of
          a session (or when they are read on request).
        </p>
      }
      <!-- prettier-ignore -->
      <p class="hint" [class.warn]="stale()">@if (failed()) {Could not load the limits.} @else if (updated()) {Last updated {{ updated() }}{{ stale() ? ' (may be outdated)' : '' }}.} @else {Never updated.}</p>
    </div>
  `,
  styles: `
    .windows {
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
    .fill {
      height: 100%;
      background: var(--mat-sys-on-surface-variant);
    }
    .level-high,
    .level-exhausted {
      .percent {
        color: var(--mat-sys-error);
        font-weight: 700;
      }
      .fill {
        background: var(--mat-sys-error);
      }
    }
    .reset,
    .hint {
      margin: 0;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .old {
      text-decoration: line-through;
    }
    .warn {
      color: var(--mat-sys-error);
    }
  `,
})
export class LimitWindows implements OnInit {
  private readonly store = inject(LimitsStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly now = signal(Date.now());

  protected readonly failed = this.store.failed;
  protected readonly views = computed(() => {
    const limits = this.store.limits();
    return limits ? limitViews(limits, this.now()) : [];
  });
  protected readonly stale = computed(() => {
    const limits = this.store.limits();
    return limits !== null && isStale(limits, this.now());
  });
  protected readonly updated = computed(() => {
    const at = this.store.limits()?.updatedAt;
    return at ? formatTime(at, this.now()) : null;
  });

  ngOnInit(): void {
    this.store.start();
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }
}
