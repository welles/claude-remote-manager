import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  input,
  model,
  viewChild,
} from '@angular/core';
import { AppIcon } from './icon';

/**
 * A panel at the right edge with a title, a close button and its own
 * scrolling: full screen on phones, a drawer on desktops, or, when
 * `docked`, a permanent column of the page (no close button). Its content
 * stays in the page while closed (hidden), so it keeps its state. Esc
 * closes it; opening moves the focus to its title. Actions for the header
 * go into an element with `panel-actions`.
 */
@Component({
  selector: 'app-side-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppIcon],
  host: {
    '[class.open]': 'open()',
    '[class.docked]': 'docked()',
    '[attr.role]': 'docked() ? "complementary" : "dialog"',
    '[attr.aria-modal]': 'open() && !docked() ? "true" : null',
    '[attr.aria-labelledby]': 'titleId',
    '(keydown.escape)': 'close()',
  },
  template: `
    <header class="head">
      <h2 class="title" [id]="titleId" tabindex="-1" #title>
        {{ heading() }}
      </h2>
      <ng-content select="[panel-actions]" />
      @if (!docked()) {
        <button
          type="button"
          class="app-icon-btn"
          aria-label="Close"
          (click)="close()"
          data-testid="panel-close"
        >
          <app-icon name="close" />
        </button>
      }
    </header>
    <div class="body"><ng-content /></div>
  `,
  styles: `
    :host {
      position: fixed;
      z-index: 6;
      inset: 0;
      display: none;
      flex-direction: column;
      background: var(--mat-sys-surface-container-low);
      color: var(--mat-sys-on-surface);
    }
    :host(.open),
    :host(.docked) {
      display: flex;
    }
    @media (min-width: 600px) {
      :host(:not(.docked)) {
        left: auto;
        width: var(--app-panel-width, min(480px, 100vw));
        border-left: 1px solid var(--mat-sys-outline-variant);
        box-shadow: var(--mat-sys-level3);
      }
    }
    :host(.docked) {
      position: sticky;
      top: var(--app-top-inset, 0px);
      z-index: 1;
      height: calc(100dvh - var(--app-top-inset, 0px));
      border-left: 1px solid var(--mat-sys-outline-variant);
    }
    @media (prefers-reduced-motion: no-preference) {
      :host(.open:not(.docked)) {
        animation: enter var(--app-motion) var(--app-ease);
      }
    }
    @keyframes enter {
      from {
        transform: translateX(24px);
        opacity: 0;
      }
    }
    .head {
      display: flex;
      align-items: center;
      gap: var(--app-space-1);
      flex: none;
      min-height: var(--app-bar-height);
      padding: 0 var(--app-space-2) 0 var(--app-space-4);
      padding-top: env(safe-area-inset-top);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .title {
      flex: 1;
      min-width: 0;
      margin: 0;
      font: var(--mat-sys-title-medium);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      outline: none;
    }
    /* Sections of the content: label, then the section's own markup. */
    :host ::ng-deep .panel-section {
      display: flex;
      flex-direction: column;
      gap: var(--app-space-2);
      padding: var(--app-space-3) var(--app-space-4);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    :host ::ng-deep .panel-section > .app-section-label {
      margin: 0;
    }
    :host ::ng-deep .panel-section:empty {
      display: none;
    }
    .body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding-bottom: env(safe-area-inset-bottom);
    }
  `,
})
export class AppSidePanel {
  readonly heading = input.required<string>();
  /** A permanent column of the page instead of an overlay. */
  readonly docked = input(false);
  readonly open = model(false);
  readonly titleId = `side-panel-${Math.random().toString(36).slice(2, 9)}`;
  private readonly title = viewChild<ElementRef<HTMLElement>>('title');
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly injector = inject(Injector);

  constructor() {
    effect(() => {
      if (this.open() && !this.docked()) {
        afterNextRender(() => this.title()?.nativeElement.focus(), {
          injector: this.injector,
        });
      }
    });
  }

  close(): void {
    if (!this.docked()) {
      this.open.set(false);
    }
  }

  /** Scrolls an element of the content (by id) to the top of the panel. */
  reveal(id: string): void {
    afterNextRender(
      () => {
        // Only the panel scrolls (scrollIntoView would move the page too).
        const host = this.host.nativeElement;
        const body = host.querySelector<HTMLElement>('.body');
        const target = host.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
        if (body && target) {
          body.scrollTop +=
            target.getBoundingClientRect().top -
            body.getBoundingClientRect().top;
        }
      },
      { injector: this.injector },
    );
  }
}
