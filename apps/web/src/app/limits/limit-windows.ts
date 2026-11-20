import {
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { formatTime, isStale, limitViews } from './limit-format';
import { Meter } from '../ui/meter';
import { LimitsStore } from './limits-store';

/**
 * The account's plan limit windows with percent, meter and reset time, and
 * when they were last read: in the limits dialog of the session list and
 * in the session's details.
 */
@Component({
  selector: 'app-limit-windows',
  imports: [Meter],
  template: `
    <div class="flex flex-col gap-3" data-testid="limits-details">
      @for (view of views(); track view.type) {
        @let high = view.level !== 'normal';
        <div class="flex flex-col gap-1.5" data-testid="limit">
          <div
            class="type-body-medium flex items-baseline justify-between gap-2"
          >
            <span>{{ view.label }}</span>
            <span
              class="type-body-small tabular-nums"
              [class]="
                high ? 'font-bold text-error' : 'text-on-surface-variant'
              "
              >{{ view.percentText }}</span
            >
          </div>
          <app-meter
            [value]="view.percent"
            [high]="high"
            [label]="view.label"
          />
          <span
            class="type-body-small text-on-surface-variant"
            [class.line-through]="view.resetPassed"
            >{{ view.resetText }}</span
          >
        </div>
      } @empty {
        <p class="type-body-small m-0 text-on-surface-variant">
          Not known yet: Claude Code reports the limits with the first answer of
          a session (or when they are read on request).
        </p>
      }
      <!-- prettier-ignore -->
      <p class="type-body-small m-0" [class]="stale() ? 'text-error' : 'text-on-surface-variant'">@if (failed()) {Could not load the limits.} @else if (updated()) {Last updated {{ updated() }}{{ stale() ? ' (may be outdated)' : '' }}.} @else {Never updated.}</p>
    </div>
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
