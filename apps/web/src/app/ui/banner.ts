import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A one-message strip across the page: the state of the app or of a
 * session (offline, sign-in expired, archived, clones removed, held back).
 * `kind` sets the colour: `neutral`, `attention` (needs the user) or
 * `error`. Action buttons go into an element with `banner-actions`.
 */
@Component({
  selector: 'app-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': '"banner-" + kind()' },
  template: `
    <div class="text"><ng-content /></div>
    <ng-content select="[banner-actions]" />
  `,
  styles: `
    :host {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--app-space-1) var(--app-space-3);
      padding: var(--app-space-2) var(--app-space-3);
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-small);
      background: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-medium);
    }
    :host(.banner-attention) {
      border-color: color-mix(
        in srgb,
        var(--app-status-attention) 45%,
        transparent
      );
      background: var(--app-status-attention-container);
      color: var(--app-status-on-attention-container);
    }
    :host(.banner-error) {
      border-color: color-mix(in srgb, var(--mat-sys-error) 45%, transparent);
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }
    .text {
      flex: 1 1 16em;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    :host ::ng-deep [banner-actions] {
      display: flex;
      flex-wrap: wrap;
      gap: var(--app-space-2);
      margin-left: auto;
    }
  `,
})
export class AppBanner {
  readonly kind = input<'neutral' | 'attention' | 'error'>('neutral');
}
