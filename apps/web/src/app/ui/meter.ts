import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

/**
 * How full something is (context window, plan limits): a thin bar, in the
 * error colour from `high` on. Full width by default; `inline` makes it a
 * short bar inside a chip. The app's only meter: loading uses
 * `mat-progress-bar`.
 */
@Component({
  selector: 'app-meter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    '[attr.aria-valuenow]': 'percent()',
    '[attr.aria-label]': 'label()',
    '[attr.aria-hidden]': 'label() ? null : "true"',
    class:
      'block h-1 flex-none overflow-hidden rounded-full bg-surface-container-highest',
    '[class.w-6]': 'inline()',
  },
  template: `<span
    class="block h-full"
    [class.bg-primary]="!high()"
    [class.bg-error]="high()"
    [style.width.%]="percent()"
  ></span>`,
})
export class Meter {
  /** Percent, 0-100 (clamped); `null` when unknown (empty bar). */
  readonly value = input<number | null>(null);
  readonly high = input(false);
  readonly inline = input(false, { transform: booleanAttribute });
  /** Accessible name; without one the meter is hidden from assistive tech. */
  readonly label = input<string | null>(null);

  protected readonly percent = computed(() =>
    Math.max(0, Math.min(100, Math.round(this.value() ?? 0))),
  );
}
