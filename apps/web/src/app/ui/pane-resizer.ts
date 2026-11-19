import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  signal,
  type WritableSignal,
} from '@angular/core';

/** Limits and default of a resizable column, in CSS pixels. */
export interface PaneWidthRange {
  min: number;
  max: number;
  initial: number;
  /**
   * Largest share of the window the column may take (0-1), the same limit
   * as in the column's CSS (`min(var(--width), <share × 100>vw)`).
   */
  windowShare: number;
}

/**
 * The width of a resizable column, kept in `localStorage` under `key` (only
 * for this page where storage is unavailable). Changes are limited to the
 * range and the window's share; the column's CSS applies the same share
 * to a stored width when the window is narrower (see the session view).
 */
export class PaneWidth {
  readonly value: WritableSignal<number>;

  constructor(
    private readonly key: string,
    readonly range: PaneWidthRange,
  ) {
    this.value = signal(this.stored() ?? range.initial);
  }

  set(width: number): void {
    this.value.set(this.clamp(width));
  }

  /** Stores the current width (after a drag, not on every move). */
  save(): void {
    try {
      if (this.value() === this.range.initial) {
        localStorage.removeItem(this.key);
      } else {
        localStorage.setItem(this.key, String(this.value()));
      }
    } catch {
      // Not stored (private mode): only for this page.
    }
  }

  reset(): void {
    this.value.set(this.range.initial);
    this.save();
  }

  /** Limits to the range and to the window's share now. */
  clamp(width: number): number {
    return Math.round(Math.min(this.max(), Math.max(this.range.min, width)));
  }

  /** The largest width the window allows now. */
  max(): number {
    const window =
      typeof innerWidth === 'number' && innerWidth > 0
        ? innerWidth * this.range.windowShare
        : this.range.max;
    return Math.round(
      Math.max(this.range.min, Math.min(this.range.max, window)),
    );
  }

  private stored(): number | null {
    try {
      // Only the range: the window may be narrower now than later (the
      // column's CSS limits it to the window meanwhile).
      const stored = Number(localStorage.getItem(this.key));
      return stored > 0
        ? Math.round(Math.min(this.range.max, Math.max(this.range.min, stored)))
        : null;
    } catch {
      return null;
    }
  }
}

/** Arrow keys move the edge by this much (with Shift: four times). */
const KEY_STEP = 16;

/**
 * A handle on the edge of a column to change its width: drag it, or focus
 * it and use the arrow keys; a double click (or Enter) restores the
 * default. `edge` is the side of the column it sits on: `end` for a column
 * on the left (it grows to the right), `start` for one on the right. Put it
 * inside the column, which must be positioned (it is absolutely placed).
 */
@Component({
  selector: 'app-pane-resizer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'vertical',
    '[attr.aria-label]': 'label()',
    '[attr.aria-valuenow]': 'width().clamp(width().value())',
    '[attr.aria-valuemin]': 'width().range.min',
    '[attr.aria-valuemax]': 'width().max()',
    '[attr.aria-valuetext]': 'width().clamp(width().value()) + " pixels"',
    'aria-keyshortcuts': 'ArrowLeft ArrowRight Home End Enter',
    title: 'Drag or use the arrow keys to resize; double-click or Enter resets',
    '[class.edge-start]': 'edge() === "start"',
    '[class.edge-end]': 'edge() === "end"',
    '[class.dragging]': 'dragging()',
    '(pointerdown)': 'start($event)',
    '(pointermove)': 'move($event)',
    '(pointerup)': 'end($event)',
    '(pointercancel)': 'end($event)',
    '(lostpointercapture)': 'end($event)',
    '(dblclick)': 'width().reset()',
    '(keydown)': 'key($event)',
  },
  template: '',
  styles: `
    :host {
      position: absolute;
      top: 0;
      bottom: 0;
      z-index: 4;
      width: 9px;
      cursor: col-resize;
      touch-action: none;
      outline: none;
    }
    :host(.edge-end) {
      right: -5px;
    }
    :host(.edge-start) {
      left: -5px;
    }
    /* A line on the column's border while hovered, dragged or focused. */
    :host::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: 3px;
      width: 3px;
      background: var(--mat-sys-primary);
      opacity: 0;
    }
    :host(:hover)::after,
    :host(.dragging)::after,
    :host(:focus-visible)::after {
      opacity: 1;
    }
    @media (prefers-reduced-motion: no-preference) {
      :host::after {
        transition: opacity var(--app-motion-fast) var(--app-ease);
      }
      :host(:hover)::after {
        transition-delay: 150ms;
      }
    }
  `,
})
export class PaneResizer {
  readonly width = input.required<PaneWidth>();
  readonly edge = input.required<'start' | 'end'>();
  readonly label = input.required<string>();

  protected readonly dragging = signal(false);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private origin = { x: 0, width: 0 };

  protected start(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    this.origin = { x: event.clientX, width: this.shown() };
    this.host.nativeElement.setPointerCapture(event.pointerId);
    this.dragging.set(true);
  }

  protected move(event: PointerEvent): void {
    if (!this.dragging()) {
      return;
    }
    const delta = event.clientX - this.origin.x;
    this.width().set(
      this.origin.width + (this.edge() === 'end' ? delta : -delta),
    );
  }

  protected end(event: PointerEvent): void {
    if (!this.dragging()) {
      return;
    }
    this.dragging.set(false);
    if (this.host.nativeElement.hasPointerCapture(event.pointerId)) {
      this.host.nativeElement.releasePointerCapture(event.pointerId);
    }
    this.width().save();
  }

  /** The width the column has now (its CSS may hold it narrower). */
  private shown(): number {
    const column = this.host.nativeElement.parentElement;
    return column?.getBoundingClientRect().width || this.width().value();
  }

  protected key(event: KeyboardEvent): void {
    // Leave browser shortcuts (Alt+Left: back) alone.
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const width = this.width();
    const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    // Right moves the edge to the right: wider for a left column.
    const grow = this.edge() === 'end' ? 1 : -1;
    switch (event.key) {
      case 'ArrowRight':
        width.set(this.shown() + step * grow);
        break;
      case 'ArrowLeft':
        width.set(this.shown() - step * grow);
        break;
      case 'Home':
        width.set(width.range.min);
        break;
      case 'End':
        width.set(width.range.max);
        break;
      case 'Enter':
        width.reset();
        event.preventDefault();
        return;
      default:
        return;
    }
    event.preventDefault();
    width.save();
  }
}
