import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
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
 * focusable element is the close button.
 */
@Component({
  selector: 'app-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppIcon],
  template: `
    <dialog
      #dialog
      class="dialog"
      [attr.aria-labelledby]="titleId"
      [attr.data-testid]="testId()"
      (close)="closed.emit()"
    >
      <header class="head">
        <h2 class="title" [id]="titleId">{{ heading() }}</h2>
        <button
          type="button"
          class="close"
          aria-label="Close"
          (click)="close()"
        >
          <app-icon name="close" />
        </button>
      </header>
      <div class="body"><ng-content /></div>
      <ng-content select="[dialog-actions]" />
    </dialog>
  `,
  styles: `
    .dialog {
      width: min(560px, calc(100vw - 32px));
      max-width: none;
      max-height: 90dvh;
      margin: 8vh auto auto;
      box-sizing: border-box;
      padding: 0;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-large);
      background: var(--mat-sys-surface-container-high);
      color: var(--mat-sys-on-surface);
      box-shadow: var(--mat-sys-level3);
    }
    .dialog[open] {
      display: flex;
      flex-direction: column;
    }
    :host(.wide) .dialog {
      width: min(640px, calc(100vw - 32px));
    }
    .dialog::backdrop {
      background: var(--app-scrim);
    }
    .head {
      display: flex;
      align-items: center;
      gap: var(--app-space-2);
      padding: var(--app-space-2) var(--app-space-2) 0 var(--app-space-4);
      min-height: 48px;
    }
    .title {
      flex: 1;
      min-width: 0;
      margin: 0;
      font: var(--mat-sys-headline-small);
      overflow-wrap: anywhere;
    }
    .close {
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      border: 0;
      border-radius: var(--mat-sys-corner-small);
      background: none;
      color: var(--mat-sys-on-surface-variant);
      cursor: pointer;
    }
    .close:hover {
      background: var(--mat-sys-surface-container-highest);
    }
    .body {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: var(--app-space-2) var(--app-space-4) var(--app-space-3);
    }
    :host ::ng-deep [dialog-actions] {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: var(--app-space-2);
      padding: var(--app-space-3) var(--app-space-4);
      border-top: 1px solid var(--mat-sys-outline-variant);
    }
    @media (max-width: 599px) {
      .dialog {
        width: 100%;
        max-height: 92dvh;
        margin: auto 0 0;
        border-width: 1px 0 0;
        border-radius: var(--mat-sys-corner-extra-large-top);
        padding-bottom: env(safe-area-inset-bottom);
      }
      :host(.wide) .dialog {
        width: 100%;
      }
    }
    @media (prefers-reduced-motion: no-preference) {
      .dialog[open] {
        animation: enter var(--app-motion) var(--app-ease);
      }
      @media (max-width: 599px) {
        .dialog[open] {
          animation-name: sheet;
        }
      }
    }
    @keyframes enter {
      from {
        opacity: 0;
        transform: translateY(8px);
      }
    }
    @keyframes sheet {
      from {
        transform: translateY(40px);
        opacity: 0.6;
      }
    }
  `,
})
export class AppDialog {
  readonly heading = input.required<string>();
  /** `data-testid` of the `<dialog>` element. */
  readonly testId = input<string | null>(null);
  /** Emitted when the dialog closed (button, Esc or `close()`). */
  readonly closed = output<void>();

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
