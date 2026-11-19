import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  inject,
  signal,
} from '@angular/core';
import { AppIcon } from './icon';

/** How long a toast without problems stays. */
export const TOAST_DURATION_MS = 6000;

export interface Toast {
  id: number;
  /** One line, e.g. `Session archived`. */
  title: string;
  /** Details, one per line. */
  lines: string[];
  /** `error` stays until dismissed; `info` goes after a few seconds. */
  kind: 'info' | 'error';
}

let nextId = 0;

/**
 * Results that need nothing from the user (e.g. clones removed): shown as
 * a toast instead of a dialog. Only the app shell renders them.
 */
@Injectable({ providedIn: 'root' })
export class Toasts {
  private readonly items = signal<Toast[]>([]);
  readonly all = this.items.asReadonly();

  show(toast: Omit<Toast, 'id' | 'lines' | 'kind'> & Partial<Toast>): void {
    const item: Toast = {
      lines: [],
      kind: 'info',
      ...toast,
      id: ++nextId,
    };
    this.items.update((items) => [...items, item]);
    if (item.kind === 'info') {
      setTimeout(() => this.dismiss(item.id), TOAST_DURATION_MS);
    }
  }

  dismiss(id: number): void {
    this.items.update((items) => items.filter((item) => item.id !== id));
  }
}

/**
 * The toasts of the app, at the top of the page (the bottom holds the
 * input of a session), newest last.
 */
@Component({
  selector: 'app-toasts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppIcon],
  template: `
    <div class="region" role="status" aria-live="polite">
      @for (toast of toasts.all(); track toast.id) {
        <div
          class="toast"
          [class.error]="toast.kind === 'error'"
          data-testid="toast"
        >
          <app-icon
            class="mark"
            [name]="toast.kind === 'error' ? 'alert' : 'check'"
          />
          <div class="text">
            <strong class="title">{{ toast.title }}</strong>
            @for (line of toast.lines; track $index) {
              <span class="line">{{ line }}</span>
            }
          </div>
          <button
            type="button"
            class="dismiss"
            aria-label="Dismiss"
            (click)="toasts.dismiss(toast.id)"
            data-testid="toast-dismiss"
          >
            <app-icon name="close" />
          </button>
        </div>
      }
    </div>
  `,
  styles: `
    .region {
      position: fixed;
      inset: calc(12px + env(safe-area-inset-top)) 0 auto;
      z-index: 20;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 0 16px;
      pointer-events: none;
    }
    .toast {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      width: min(480px, 100%);
      box-sizing: border-box;
      padding: 10px 8px 10px 14px;
      border-radius: var(--mat-sys-corner-small);
      background: var(--mat-sys-inverse-surface);
      color: var(--mat-sys-inverse-on-surface);
      box-shadow: var(--mat-sys-level3);
      font: var(--mat-sys-body-medium);
      pointer-events: auto;
      overflow-wrap: anywhere;
      --app-icon-size: 18px;
    }
    .toast.error {
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }
    .mark {
      flex: none;
      margin-top: 1px;
    }
    .text {
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .line {
      font: var(--mat-sys-body-small);
    }
    .dismiss {
      flex: none;
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      margin: -4px 0;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: none;
      color: inherit;
      cursor: pointer;
      --app-icon-size: 16px;
    }
    .dismiss:hover,
    .dismiss:focus-visible {
      background: color-mix(in srgb, currentColor 12%, transparent);
    }
  `,
})
export class AppToasts {
  protected readonly toasts = inject(Toasts);
}
