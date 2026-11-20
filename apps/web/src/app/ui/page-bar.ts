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
  template: `
    @if (back(); as link) {
      <a
        class="icon-btn back"
        [routerLink]="link"
        [attr.aria-label]="backLabel()"
        data-testid="back"
      >
        <app-icon name="back" />
      </a>
    }
    <div class="titles">
      <ng-content select="[bar-title]" />
      @if (heading()) {
        <h1 class="title">{{ heading() }}</h1>
      }
      @if (subtitle()) {
        <p class="subtitle">{{ subtitle() }}</p>
      }
    </div>
    <div class="actions"><ng-content /></div>
  `,
  styles: `
    :host {
      position: sticky;
      top: var(--app-top-inset, 0px);
      z-index: 3;
      display: flex;
      align-items: center;
      gap: var(--app-space-1);
      min-height: var(--app-bar-height);
      margin: 0 calc(-1 * var(--app-gutter));
      padding: 0 calc(var(--app-gutter) - 8px);
      box-sizing: border-box;
      background: var(--mat-sys-surface);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    :host:not(:has(.back)) {
      padding-left: var(--app-gutter);
    }
    .titles {
      flex: 1;
      min-width: 0;
    }
    .title {
      margin: 0;
      font: var(--mat-sys-title-large);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .subtitle {
      margin: 0;
      font: var(--mat-sys-body-small);
      font-family: var(--app-font-mono);
      color: var(--mat-sys-on-surface-variant);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: var(--app-space-1);
      flex: none;
    }
    .actions:empty {
      display: none;
    }
  `,
})
export class AppPageBar {
  readonly heading = input<string | null>(null);
  readonly subtitle = input<string | null>(null);
  /** Router link of the parent page; shows a back button. */
  readonly back = input<string | readonly unknown[] | null>(null);
  readonly backLabel = input('Back');
}
