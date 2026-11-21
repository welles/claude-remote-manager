import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { AppIcon } from '../ui/icon';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import {
  PREVIEW_FRAME_SANDBOX,
  type PreviewDto,
} from '@claude-remote-manager/shared-types';
import { PREVIEW_STATE_LABELS, previewHref } from './previews-api';

/**
 * A running preview embedded in the session view: a side sheet (the whole
 * screen on phones) with the preview in a frame, Reload, New tab and
 * Close (also Escape or a click beside it).
 *
 * The frame is sandboxed with `PREVIEW_FRAME_SANDBOX` (the attribute is
 * static: Angular refuses bindings of `sandbox`): scripts, forms, dialogs
 * and popups work, and `allow-same-origin` keeps the preview's own origin
 * (another host than the app, so it cannot reach the app's storage, DOM or
 * cookies), which dev servers need for their storage and hot reload. It
 * may not navigate the app's window: no `allow-top-navigation`, so OAuth
 * redirects and links with `target=_top` only work in a new tab. No
 * referrer: the dev server does not learn the app's URL.
 */
@Component({
  selector: 'app-preview-frame',
  imports: [AppIcon],
  template: `
    @let p = preview();
    <div
      class="absolute inset-0 bg-scrim"
      (click)="closed.emit()"
      (keydown.enter)="closed.emit()"
      tabindex="-1"
    ></div>
    <div class="overlay-sheet [--sheet-width:min(1200px,80vw)]">
      <header class="sheet-head">
        <div class="min-w-0 flex-1">
          <h2 class="m-0 truncate type-title-medium">{{ p.name }}</h2>
          <p class="hint-text">
            {{ stateLabel() }} · port {{ p.port }}
            @if (p.problem) {
              · {{ p.problem }}
            }
          </p>
        </div>
        @if (p.state !== 'stopped') {
          <button
            type="button"
            class="icon-btn"
            (click)="reload()"
            title="Reload"
            data-testid="preview-reload"
          >
            <app-icon name="refresh" /><span class="sr-only">Reload</span>
          </button>
          @if (href(); as link) {
            <a
              class="icon-btn"
              [href]="link"
              target="_blank"
              rel="noopener noreferrer"
              referrerpolicy="no-referrer"
              title="Open in a new tab"
              ><app-icon name="external" /><span class="sr-only"
                >New tab</span
              ></a
            >
          }
        }
        <button
          type="button"
          class="icon-btn"
          (click)="closed.emit()"
          title="Close"
          data-testid="close-preview"
        >
          <app-icon name="close" /><span class="sr-only">Close</span>
        </button>
      </header>
      <div class="flex min-h-0 flex-1 flex-col">
        @if (p.state === 'stopped') {
          <p class="hint-text p-4" data-testid="preview-stopped">
            This preview was stopped.
          </p>
        } @else if (frameUrl(); as frame) {
          @if (!reloading()) {
            <iframe
              class="w-full flex-1 border-0 bg-[#fff]"
              [src]="frame"
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
              referrerpolicy="no-referrer"
              allow=""
              [title]="p.name"
              data-testid="preview-frame"
            ></iframe>
          }
          <p class="hint-text border-t border-outline-variant px-4 py-1">
            Nothing shows? Behind Cloudflare Access, open the preview in a new
            tab once to sign in to it.
          </p>
        }
      </div>
    </div>
  `,
  host: {
    class: 'fixed inset-0 z-1000',
    role: 'dialog',
    'aria-modal': 'true',
    '[attr.aria-label]': 'preview().name',
    '(document:keydown.escape)': 'closed.emit()',
  },
})
export class PreviewFrame {
  private readonly sanitizer = inject(DomSanitizer);

  /** The preview as it is now (see `currentPreview`). */
  readonly preview = input.required<PreviewDto>();
  readonly closed = output<void>();

  /** The template's static `sandbox` value, for tests. */
  static readonly sandbox = PREVIEW_FRAME_SANDBOX;

  protected readonly href = computed(() => previewHref(this.preview()));
  protected readonly stateLabel = computed(
    () => PREVIEW_STATE_LABELS[this.preview().state],
  );
  /** Only ever the preview's own http(s) URL (the app's CSP allows only preview hosts). */
  protected readonly frameUrl = computed<SafeResourceUrl | null>(() => {
    const href = this.href();
    return href ? this.sanitizer.bypassSecurityTrustResourceUrl(href) : null;
  });
  protected readonly reloading = signal(false);

  protected reload(): void {
    // A cross-origin frame cannot be reloaded from here: recreate it.
    this.reloading.set(true);
    setTimeout(() => this.reloading.set(false));
  }
}
