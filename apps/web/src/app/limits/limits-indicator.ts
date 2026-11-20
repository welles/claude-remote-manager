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
import { Meter } from '../ui/meter';
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
  imports: [AppDialog, LimitWindows, MatButtonModule, Meter],
  template: `
    @let view = headline();
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
      (click)="details.open()"
      [attr.aria-label]="label()"
      data-testid="limits"
    >
      @if (view) {
        <app-meter
          inline
          [value]="view.percent"
          [high]="view.level !== 'normal'"
        />
        <span
          [class.opacity-70]="stale()"
          [class.line-through]="view.resetPassed"
          >{{ view.short }} {{ view.percentText }}</span
        >
      } @else {
        Limits ?
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
