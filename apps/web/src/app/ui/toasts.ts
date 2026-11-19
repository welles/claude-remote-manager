import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { AppIcon } from './icon';

/** How long a toast without problems stays, plus a bit per line. */
export const TOAST_DURATION_MS = 6000;
export const TOAST_LINE_MS = 2000;

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
 * a toast instead of a dialog. Only the app shell renders them. Close a
 * modal dialog before showing one: the page under a modal is inert.
 */
@Injectable({ providedIn: 'root' })
export class Toasts {
  private readonly items = signal<Toast[]>([]);
  readonly all = this.items.asReadonly();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  show(toast: Omit<Toast, 'id' | 'lines' | 'kind'> & Partial<Toast>): void {
    const item: Toast = {
      lines: [],
      kind: 'info',
      ...toast,
      id: ++nextId,
    };
    this.items.update((items) => [...items, item]);
    this.resume(item.id);
  }

  dismiss(id: number): void {
    this.pause(id);
    this.items.update((items) => items.filter((item) => item.id !== id));
  }

  /** Keeps a toast while the user reads it (pointer or focus on it). */
  pause(id: number): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  /** Lets an info toast go after its time again. */
  resume(id: number): void {
    const item = this.items().find((toast) => toast.id === id);
    if (!item || item.kind !== 'info' || this.timers.has(id)) {
      return;
    }
    this.timers.set(
      id,
      setTimeout(
        () => this.dismiss(id),
        TOAST_DURATION_MS + TOAST_LINE_MS * item.lines.length,
      ),
    );
  }
}

/**
 * The toasts of the app, at the top of the page below the bar (the bottom
 * holds the input of a session), newest last. Problems are announced as
 * alerts, the rest politely.
 */
@Component({
  selector: 'app-toasts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppIcon, NgTemplateOutlet],
  template: `
    <div class="region">
      <div role="alert" class="group">
        @for (toast of errors(); track toast.id) {
          <ng-container
            [ngTemplateOutlet]="item"
            [ngTemplateOutletContext]="{ $implicit: toast }"
          />
        }
      </div>
      <div role="status" class="group">
        @for (toast of infos(); track toast.id) {
          <ng-container
            [ngTemplateOutlet]="item"
            [ngTemplateOutletContext]="{ $implicit: toast }"
          />
        }
      </div>
    </div>
    <ng-template #item let-toast>
      <div
        class="toast"
        [class.error]="toast.kind === 'error'"
        (mouseenter)="toasts.pause(toast.id)"
        (mouseleave)="toasts.resume(toast.id)"
        (focusin)="toasts.pause(toast.id)"
        (focusout)="toasts.resume(toast.id)"
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
          [attr.aria-label]="'Dismiss: ' + toast.title"
          (click)="toasts.dismiss(toast.id)"
          data-testid="toast-dismiss"
        >
          <app-icon name="close" />
        </button>
      </div>
    </ng-template>
  `,
  styles: `
    /* Below the page bar (and the app's banners above it), above the
       bars and panels (not above the file viewer and preview frame). */
    .region {
      position: fixed;
      inset: calc(
          var(--app-top-inset, 0px) + var(--app-bar-height) + var(--app-space-2)
        )
        0 auto;
      z-index: 20;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--app-space-2);
      padding: 0 max(var(--app-space-4), env(safe-area-inset-right)) 0
        max(var(--app-space-4), env(safe-area-inset-left));
      pointer-events: none;
    }
    .group {
      display: contents;
    }
    .toast {
      display: flex;
      align-items: flex-start;
      gap: var(--app-space-2);
      width: min(480px, 100%);
      box-sizing: border-box;
      padding: var(--app-space-1) var(--app-space-1) var(--app-space-1)
        var(--app-space-3);
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
      margin-top: 11px;
    }
    .text {
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      padding: var(--app-space-2) 0;
    }
    .line {
      font: var(--mat-sys-body-small);
    }
    .dismiss {
      flex: none;
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      padding: 0;
      border: 0;
      border-radius: var(--mat-sys-corner-small);
      background: none;
      color: inherit;
      cursor: pointer;
      --app-icon-size: 16px;
    }
    .dismiss:hover,
    .dismiss:focus-visible {
      background: color-mix(in srgb, currentColor 12%, transparent);
    }
    @media (prefers-reduced-motion: no-preference) {
      .toast {
        animation: enter var(--app-motion) var(--app-ease);
      }
    }
    @keyframes enter {
      from {
        opacity: 0;
        transform: translateY(-8px);
      }
    }
  `,
})
export class AppToasts {
  protected readonly toasts = inject(Toasts);
  protected readonly errors = computed(() =>
    this.toasts.all().filter((toast) => toast.kind === 'error'),
  );
  protected readonly infos = computed(() =>
    this.toasts.all().filter((toast) => toast.kind === 'info'),
  );
}
