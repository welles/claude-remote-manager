import {
  ChangeDetectionStrategy,
  booleanAttribute,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { AppIcon } from './icon';

let nextId = 0;

/**
 * The one dialog of the app: a native modal `<dialog>` (focus trap and Esc
 * for free, no Material overlay) with a title, a close button, a body that
 * scrolls and an action row that stays visible. Below 600 px it is a bottom
 * sheet. Content goes into the default slot; buttons into an element with
 * `dialog-actions`. Opening never focuses a confirming button: the first
 * focusable element is the close button, unless `initialFocus` names the
 * field to type into (dialogs that are one text input).
 */
@Component({
  selector: 'app-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppIcon],
  template: `
    <dialog
      #dialog
      class="m-[8vh_auto_auto] box-border max-h-[90dvh] max-w-none rounded-lg border border-outline-variant bg-surface-container-high p-0 text-on-surface shadow-3 open:flex open:flex-col backdrop:bg-scrim max-sm:m-[auto_0_0] max-sm:max-h-[92dvh] max-sm:w-full max-sm:rounded-t-xl max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-[env(safe-area-inset-bottom)] max-sm:motion-safe:open:animate-sheet-in sm:motion-safe:open:animate-dialog-in"
      [class]="
        wide()
          ? 'sm:w-[min(640px,calc(100vw-32px))]'
          : 'sm:w-[min(560px,calc(100vw-32px))]'
      "
      [attr.aria-labelledby]="titleId"
      [attr.data-testid]="testId()"
      (close)="closed.emit()"
    >
      <header class="flex min-h-12 items-center gap-2 pt-2 pr-2 pl-4">
        <h2
          class="m-0 min-w-0 flex-1 type-headline-small wrap-anywhere"
          [id]="titleId"
        >
          {{ heading() }}
        </h2>
        <button
          type="button"
          class="icon-btn"
          aria-label="Close"
          (click)="close()"
        >
          <app-icon name="close" />
        </button>
      </header>
      <div
        class="min-h-0 flex-auto overflow-y-auto overscroll-contain px-4 pt-2 pb-3"
      >
        <ng-content />
      </div>
      <div
        class="flex flex-wrap justify-end gap-2 border-t border-outline-variant px-4 py-3 empty:hidden [&>*]:contents"
      >
        <ng-content select="[dialog-actions]" />
      </div>
    </dialog>
  `,
})
export class AppDialog {
  readonly heading = input.required<string>();
  /** 640 px wide instead of 560 px (from 600 px). */
  readonly wide = input(false, { transform: booleanAttribute });
  /** `data-testid` of the `<dialog>` element. */
  readonly testId = input<string | null>(null);
  /** CSS selector of the element to focus when opened, e.g. the input. */
  readonly initialFocus = input<string | null>(null);
  /** Emitted when the dialog closed (button, Esc or `close()`). */
  readonly closed = output<void>();
  private readonly injector = inject(Injector);

  protected readonly titleId = `app-dialog-title-${nextId++}`;
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  get isOpen(): boolean {
    const dialog = this.dialog().nativeElement;
    return dialog.open || dialog.hasAttribute('open');
  }

  open(): void {
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    }
    const selector = this.initialFocus();
    if (selector) {
      // After the content the opener just switched on has rendered.
      afterNextRender(
        () => dialog.querySelector<HTMLElement>(selector)?.focus(),
        { injector: this.injector },
      );
    }
  }

  close(): void {
    const dialog = this.dialog().nativeElement;
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
      this.closed.emit();
    }
  }
}
