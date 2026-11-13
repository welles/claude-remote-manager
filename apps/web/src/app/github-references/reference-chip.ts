import {
  createFlexibleConnectedPositionStrategy,
  createOverlayRef,
  createRepositionScrollStrategy,
  type ConnectedPosition,
  type OverlayRef,
} from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  ViewContainerRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
  type ComponentRef,
} from '@angular/core';
import type { ReferencePreview } from './reference-preview';
import {
  stateLabel,
  type ReferenceChipModel,
  type ReferenceOptions,
} from './references';

/** Pointer devices that can hover (not touch screens). */
const canHover = () =>
  typeof matchMedia === 'function' &&
  matchMedia('(hover: hover) and (pointer: fine)').matches;

/**
 * A GitHub issue or pull request as a chip: state colour, number and
 * title. Its preview (with the link to GitHub) opens on hover with a mouse
 * and on click or tap everywhere; on a phone a tap opens it and a tap
 * outside closes it, so the link is never one accidental tap away.
 */
@Component({
  selector: 'app-reference-chip',
  // The overlay functions, not the CDK's overlay directives or @defer: the
  // app shell (menu) has them already, the others would grow the first
  // load. The preview is imported when it is first opened.
  imports: [],
  template: `
    <button
      type="button"
      class="chip state-{{ state() }}"
      #origin
      (click)="toggle()"
      (mouseenter)="hover(true)"
      (mouseleave)="hover(false)"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="label()"
      [title]="label()"
      data-testid="reference-chip"
    >
      <span class="dot" aria-hidden="true"></span>
      <span class="token">{{ token() }}</span>
      @if (chip().title) {
        <span class="title">{{ chip().title }}</span>
      } @else if (chip().status === 'failed') {
        <span class="title">{{ stateText() }}</span>
      }
      @if (extras()) {
        <span class="extras">+{{ extras() }}</span>
      }
    </button>
  `,
  styles: `
    :host {
      display: inline;
      max-width: 100%;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 22em;
      margin: 1px 0;
      padding: 1px 8px;
      vertical-align: bottom;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 12px;
      background: var(--mat-sys-surface-container-high);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-medium);
      cursor: pointer;
    }
    @media (max-width: 480px) {
      .chip {
        max-width: 15em;
      }
    }
    .dot {
      flex-shrink: 0;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #6b7280;
    }
    .state-open .dot {
      background: #1a7f37;
    }
    .state-merged .dot {
      background: #8250df;
    }
    .state-closed .dot {
      background: #cf222e;
    }
    .state-failed {
      border-style: dashed;
    }
    .token {
      flex-shrink: 0;
      font-weight: 500;
    }
    .title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .extras {
      flex-shrink: 0;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class ReferenceChip {
  readonly chip = input.required<ReferenceChipModel>();
  /** In the input: offers to give Claude comments and the diff. */
  readonly editable = input(false);
  readonly optionsChange = output<ReferenceOptions>();

  protected readonly open = signal(false);
  private pinned = false;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly element = inject(ElementRef<HTMLElement>);
  private readonly injector = inject(Injector);
  private readonly viewContainer = inject(ViewContainerRef);
  private readonly origin =
    viewChild.required<ElementRef<HTMLElement>>('origin');
  private overlay: OverlayRef | null = null;
  private preview: ComponentRef<ReferencePreview> | null = null;

  private readonly positions: ConnectedPosition[] = [
    {
      originX: 'start',
      originY: 'bottom',
      overlayX: 'start',
      overlayY: 'top',
      offsetY: 4,
    },
    {
      originX: 'start',
      originY: 'top',
      overlayX: 'start',
      overlayY: 'bottom',
      offsetY: -4,
    },
  ];
  protected readonly stateText = computed(() => stateLabel(this.chip()));
  protected readonly state = computed(() =>
    this.chip().status === 'failed' ? 'failed' : this.stateText(),
  );
  /** `#12`, or `owner/repo#12` as written. */
  protected readonly token = computed(() => this.chip().token);
  protected readonly extras = computed(() =>
    [
      ...(this.chip().comments ? ['comments'] : []),
      ...(this.chip().diff ? ['diff'] : []),
    ].join(', '),
  );
  protected readonly label = computed(() => {
    const chip = this.chip();
    const kind =
      chip.kind === 'pull_request'
        ? 'Pull request'
        : chip.kind === 'issue'
          ? 'Issue'
          : 'Reference';
    return `${kind} ${chip.repository}#${chip.number}${chip.title ? `: ${chip.title}` : ''} (${stateLabel(chip)})`;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.hoverTimer);
      this.overlay?.dispose();
    });
    effect(() => {
      const chip = this.chip();
      const editable = this.editable();
      this.preview?.setInput('chip', chip);
      this.preview?.setInput('editable', editable);
    });
  }

  protected toggle(): void {
    clearTimeout(this.hoverTimer);
    if (this.open() && this.pinned) {
      this.close();
      return;
    }
    this.pinned = true;
    this.show();
  }

  protected hover(inside: boolean): void {
    if (this.pinned || !canHover()) {
      return;
    }
    clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(
      () => (inside ? this.show() : this.close()),
      inside ? 300 : 200,
    );
  }

  protected close(): void {
    clearTimeout(this.hoverTimer);
    this.pinned = false;
    this.open.set(false);
    this.overlay?.detach();
    this.preview = null;
  }

  private async show(): Promise<void> {
    this.open.set(true);
    const { ReferencePreview } = await import('./reference-preview');
    if (!this.open()) {
      return;
    }
    if (!this.overlay) {
      const overlay = createOverlayRef(this.injector, {
        positionStrategy: createFlexibleConnectedPositionStrategy(
          this.injector,
          this.origin(),
        )
          .withPositions(this.positions)
          .withPush(true),
        scrollStrategy: createRepositionScrollStrategy(this.injector),
      });
      overlay.outsidePointerEvents().subscribe((event) => {
        // The chip itself toggles.
        if (!this.element.nativeElement.contains(event.target as Node)) {
          this.close();
        }
      });
      overlay.keydownEvents().subscribe((event) => {
        if (event.key === 'Escape') {
          this.close();
        }
      });
      overlay.overlayElement.addEventListener('mouseenter', () =>
        this.hover(true),
      );
      overlay.overlayElement.addEventListener('mouseleave', () =>
        this.hover(false),
      );
      this.overlay = overlay;
    }
    if (!this.overlay.hasAttached()) {
      const preview = this.overlay.attach(
        new ComponentPortal(ReferencePreview, this.viewContainer),
      );
      preview.setInput('chip', this.chip());
      preview.setInput('editable', this.editable());
      preview.instance.optionsChange.subscribe((options) =>
        this.optionsChange.emit(options),
      );
      preview.location.nativeElement.setAttribute('aria-label', this.label());
      this.preview = preview;
    }
  }
}
