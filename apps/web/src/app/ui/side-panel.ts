import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
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
 * go into an element with `panel-actions`; an element with `panel-edge`
 * (a resize handle) is placed outside the scrolling body.
 */
@Component({
  selector: 'app-side-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppIcon],
  host: {
    class: 'flex-col bg-surface-container-low text-on-surface',
    '[class]': 'hostClass()',
    '[attr.role]': 'docked() ? "complementary" : "dialog"',
    '[attr.aria-modal]': 'open() && !docked() ? "true" : null',
    '[attr.aria-labelledby]': 'titleId',
    '(keydown.escape)': 'close()',
  },
  template: `
    <header
      class="flex min-h-(--app-bar-height) flex-none items-center gap-1 border-b border-outline-variant pt-[env(safe-area-inset-top)] pr-2 pl-4"
    >
      <h2
        class="m-0 min-w-0 flex-1 truncate type-title-medium outline-none"
        [id]="titleId"
        tabindex="-1"
        #title
      >
        {{ heading() }}
      </h2>
      <ng-content select="[panel-actions]" />
      @if (!docked()) {
        <button
          type="button"
          class="icon-btn"
          aria-label="Close"
          (click)="close()"
          data-testid="panel-close"
        >
          <app-icon name="close" />
        </button>
      }
    </header>
    <div
      class="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]"
      #body
    >
      <ng-content />
    </div>
    <ng-content select="[panel-edge]" />
  `,
  styles: `
    @media (prefers-reduced-motion: no-preference) {
      :host(.entering) {
        animation: enter var(--app-motion) var(--app-ease);
      }
    }
    @keyframes enter {
      from {
        transform: translateX(24px);
        opacity: 0;
      }
    }
  `,
})
export class AppSidePanel {
  readonly heading = input.required<string>();
  /** A permanent column of the page instead of an overlay. */
  readonly docked = input(false);
  readonly open = model(false);
  /**
   * Phone: the whole screen; from 600 px an overlay on the right; docked: a
   * sticky column of the page (above the conversation column's bars).
   */
  protected readonly hostClass = computed(() =>
    this.docked()
      ? 'flex sticky top-[var(--app-top-inset,0px)] z-4 h-[calc(100dvh-var(--app-top-inset,0px))] border-l border-outline-variant'
      : (this.open() ? 'entering flex' : 'hidden') +
        ' fixed inset-0 z-6 sm:left-auto sm:w-(--app-panel-width,min(480px,100vw)) sm:border-l sm:border-outline-variant sm:shadow-3',
  );
  readonly titleId = `side-panel-${Math.random().toString(36).slice(2, 9)}`;
  private readonly title = viewChild<ElementRef<HTMLElement>>('title');
  /** The scrolling content (see {@link reveal}). */
  private readonly body = viewChild<ElementRef<HTMLElement>>('body');
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
        const body = this.body()?.nativeElement;
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
