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
    <!-- Below the page bar (and the app's banners above it), above the
         bars and panels (not above the file viewer and preview frame). -->
    <div
      class="pointer-events-none fixed inset-x-0 top-[calc(var(--app-top-inset,0px)+var(--app-bar-height)+8px)] z-20 flex flex-col items-center gap-2 pr-[max(16px,env(safe-area-inset-right))] pl-[max(16px,env(safe-area-inset-left))]"
    >
      <div role="alert" class="contents">
        @for (toast of errors(); track toast.id) {
          <ng-container
            [ngTemplateOutlet]="item"
            [ngTemplateOutletContext]="{ $implicit: toast }"
          />
        }
      </div>
      <div role="status" class="contents">
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
        class="pointer-events-auto box-border flex w-[min(480px,100%)] items-start gap-2 rounded-sm py-1 pr-1 pl-3 type-body-medium wrap-anywhere shadow-3 [--app-icon-size:18px] motion-safe:animate-toast-in"
        [class]="
          toast.kind === 'error'
            ? 'bg-error-container text-on-error-container'
            : 'bg-inverse-surface text-inverse-on-surface'
        "
        (mouseenter)="toasts.pause(toast.id)"
        (mouseleave)="toasts.resume(toast.id)"
        (focusin)="toasts.pause(toast.id)"
        (focusout)="toasts.resume(toast.id)"
        data-testid="toast"
      >
        <app-icon
          class="mt-[11px] flex-none"
          [name]="toast.kind === 'error' ? 'alert' : 'check'"
        />
        <div class="flex min-w-0 flex-1 flex-col gap-0.5 py-2">
          <strong>{{ toast.title }}</strong>
          @for (line of toast.lines; track $index) {
            <span class="type-body-small">{{ line }}</span>
          }
        </div>
        <button
          type="button"
          class="icon-btn [--app-icon-size:16px] [--tone-fg:currentColor]"
          [attr.aria-label]="'Dismiss: ' + toast.title"
          (click)="toasts.dismiss(toast.id)"
          data-testid="toast-dismiss"
        >
          <app-icon name="close" />
        </button>
      </div>
    </ng-template>
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
