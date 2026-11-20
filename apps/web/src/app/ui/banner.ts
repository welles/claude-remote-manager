import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  input,
} from '@angular/core';

/**
 * A one-message strip: the state of the app or of a session (offline,
 * sign-in expired, archived, clones removed, held back). `kind` sets the
 * tone: `neutral`, `attention` (needs the user) or `error`. A box in the
 * page, or with `strip` edge to edge under the app bar. Action buttons go
 * into an element with `banner-actions`; text buttons there take the
 * banner's colour.
 */
@Component({
  selector: 'app-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'flex flex-wrap items-center gap-x-3 gap-y-1 type-body-medium bg-(--tone-bg,var(--mat-sys-surface-container)) text-(--tone-fg,var(--mat-sys-on-surface)) [--mat-button-text-label-text-color:currentColor] [--mat-button-text-state-layer-color:currentColor]',
    '[class]':
      'tone() + (strip() ? " border-b px-(--app-gutter) py-2" : " border rounded-sm px-3 py-2")',
    '[class.border-outline-variant]': 'kind() === "neutral"',
    '[class.border-transparent]': 'kind() !== "neutral"',
  },
  template: `
    <div class="min-w-0 flex-[1_1_16em] [overflow-wrap:anywhere]">
      <ng-content />
    </div>
    <div class="ml-auto empty:hidden *:flex *:flex-wrap *:gap-2">
      <ng-content select="[banner-actions]" />
    </div>
  `,
})
export class AppBanner {
  readonly kind = input<'neutral' | 'attention' | 'error'>('neutral');
  readonly strip = input(false, { transform: booleanAttribute });
  protected tone(): string {
    const kind = this.kind();
    return kind === 'neutral' ? '' : `tone-${kind}`;
  }
}
