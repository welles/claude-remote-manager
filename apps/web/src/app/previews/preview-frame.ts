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
      class="backdrop"
      (click)="closed.emit()"
      (keydown.enter)="closed.emit()"
      tabindex="-1"
    ></div>
    <div class="sheet">
      <header class="head">
        <div class="title">
          <h2>{{ p.name }}</h2>
          <p class="meta">
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
            <app-icon name="refresh" /><span class="visually-hidden"
              >Reload</span
            >
          </button>
          @if (href(); as link) {
            <a
              class="icon-btn"
              [href]="link"
              target="_blank"
              rel="noopener noreferrer"
              referrerpolicy="no-referrer"
              title="Open in a new tab"
              ><app-icon name="external" /><span class="visually-hidden"
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
          <app-icon name="close" /><span class="visually-hidden">Close</span>
        </button>
      </header>
      <div class="body">
        @if (p.state === 'stopped') {
          <p class="note" data-testid="preview-stopped">
            This preview was stopped.
          </p>
        } @else if (frameUrl(); as frame) {
          @if (!reloading()) {
            <iframe
              class="frame"
              [src]="frame"
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
              referrerpolicy="no-referrer"
              allow=""
              [title]="p.name"
              data-testid="preview-frame"
            ></iframe>
          }
          <p class="hint">
            Nothing shows? Behind Cloudflare Access, open the preview in a new
            tab once to sign in to it.
          </p>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      position: fixed;
      inset: 0;
      z-index: 1000;
    }
    .backdrop {
      position: absolute;
      inset: 0;
      background: var(--app-scrim);
    }
    .sheet {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(1200px, 80vw);
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-left: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface);
      color: var(--mat-sys-on-surface);
      box-shadow: var(--mat-sys-level3);
    }
    @media (max-width: 839px) {
      .sheet {
        width: 100vw;
        border-left: 0;
      }
    }
    .head {
      display: flex;
      align-items: center;
      gap: 2px;
      min-height: var(--app-bar-height);
      padding: env(safe-area-inset-top) 4px 0 16px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .title {
      flex: 1;
      min-width: 0;
    }
    h2 {
      margin: 0;
      font: var(--mat-sys-title-medium);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta,
    .hint,
    .note {
      margin: 0;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .note {
      padding: 16px;
    }
    .hint {
      padding: 4px 16px;
      border-top: 1px solid var(--mat-sys-outline-variant);
    }
    .body {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .frame {
      flex: 1;
      width: 100%;
      border: 0;
      background: #fff;
    }
  `,
  host: {
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
