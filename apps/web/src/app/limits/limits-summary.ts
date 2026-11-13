import {
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { limitViews } from './limit-format';
import { LimitsStore } from './limits-store';

/**
 * All plan limit windows with their reset times, for the session list:
 * the header shows only the first one or two (on a phone only the 5-hour
 * window), so the weekly ones are visible here too.
 */
@Component({
  selector: 'app-limits-summary',
  template: `
    @if (views().length > 0) {
      <ul class="limits" aria-label="Plan limits" data-testid="limits-summary">
        @for (view of views(); track view.type) {
          <li>
            <span class="label">{{ view.label }}</span>
            <span
              class="value level-{{ view.level }}"
              [class.old]="view.resetPassed"
              >{{ view.percentText }}</span
            >
            <span class="reset">{{ view.resetText }}</span>
          </li>
        }
      </ul>
    }
  `,
  styles: `
    .limits {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 16px;
      margin: 0 0 12px;
      padding: 0;
      list-style: none;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    li {
      display: flex;
      gap: 6px;
      align-items: baseline;
    }
    .label {
      color: var(--mat-sys-on-surface);
    }
    .value {
      font-weight: 600;
      color: var(--mat-sys-on-surface);
    }
    .level-warning {
      color: var(--mat-sys-tertiary);
    }
    .level-critical {
      color: var(--mat-sys-error);
    }
    .old {
      text-decoration: line-through;
    }
  `,
})
export class LimitsSummary implements OnInit {
  private readonly store = inject(LimitsStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly now = signal(Date.now());

  protected readonly views = computed(() => {
    const limits = this.store.limits();
    return limits ? limitViews(limits, this.now()) : [];
  });

  ngOnInit(): void {
    this.store.start();
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }
}
