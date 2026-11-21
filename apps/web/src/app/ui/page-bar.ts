import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AppIcon } from './icon';

/**
 * The app bar of a page, first child of an `.app-page`: back link (detail
 * pages), title with an optional monospace subtitle, and actions (the
 * default slot). It sticks to the top below the global banners. A custom
 * title goes into an element with `bar-title`.
 */
@Component({
  selector: 'app-page-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppIcon, RouterLink],
  host: {
    class:
      'sticky top-[var(--app-top-inset,0px)] z-3 -mx-(--app-gutter) box-border flex min-h-(--app-bar-height) items-center gap-1 border-b border-outline-variant bg-surface pr-[calc(var(--app-gutter)-8px)]',
    '[class]':
      "back() ? 'pl-[calc(var(--app-gutter)-8px)]' : 'pl-(--app-gutter)'",
  },
  template: `
    @if (back(); as link) {
      <a
        class="icon-btn"
        [routerLink]="link"
        [attr.aria-label]="backLabel()"
        data-testid="back"
      >
        <app-icon name="back" />
      </a>
    }
    <div class="min-w-0 flex-1">
      <ng-content select="[bar-title]" />
      @if (heading()) {
        <h1 class="m-0 truncate type-title-large">{{ heading() }}</h1>
      }
      @if (subtitle()) {
        <p
          class="m-0 truncate font-mono type-body-small text-on-surface-variant"
        >
          {{ subtitle() }}
        </p>
      }
    </div>
    <div class="flex flex-none items-center gap-1"><ng-content /></div>
  `,
})
export class AppPageBar {
  readonly heading = input<string | null>(null);
  readonly subtitle = input<string | null>(null);
  /** Router link of the parent page; shows a back button. */
  readonly back = input<string | readonly unknown[] | null>(null);
  readonly backLabel = input('Back');
}
