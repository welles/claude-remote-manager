import {
  ApplicationRef,
  Component,
  DestroyRef,
  ElementRef,
  EnvironmentInjector,
  Injector,
  SecurityContext,
  computed,
  createComponent,
  effect,
  inject,
  input,
  type ComponentRef,
} from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import {
  parseReferences,
  type MessageReference,
} from '@claude-remote-manager/shared-types';
import { ReferenceChip } from './reference-chip';
import { chipOf, type ReferenceChipModel } from './references';
import { renderPromptMarkdown } from '../markdown/prompt-markdown';

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'chip'; chip: ReferenceChipModel };

/**
 * Text of a sent message with its GitHub references as chips in place;
 * references the text does not contain follow it.
 */
export function messageSegments(
  text: string,
  references: readonly MessageReference[],
): Segment[] {
  if (references.length === 0) {
    return [{ kind: 'text', text }];
  }
  const segments: Segment[] = [];
  const used = new Set<MessageReference>();
  let position = 0;
  for (const parsed of parseReferences(text, null)) {
    const reference = references.find(
      (candidate) => candidate.token === parsed.token,
    );
    if (!reference) {
      continue;
    }
    used.add(reference);
    if (parsed.start > position) {
      segments.push({ kind: 'text', text: text.slice(position, parsed.start) });
    }
    segments.push({ kind: 'chip', chip: chipOf(reference) });
    position = parsed.end;
  }
  if (position < text.length) {
    segments.push({ kind: 'text', text: text.slice(position) });
  }
  const rest = references.filter((reference) => !used.has(reference));
  if (rest.length > 0) {
    segments.push({ kind: 'text', text: segments.length > 0 ? '\n' : '' });
    rest.forEach((reference, index) => {
      if (index > 0) {
        segments.push({ kind: 'text', text: ' ' });
      }
      segments.push({ kind: 'chip', chip: chipOf(reference) });
    });
  }
  return segments;
}

/** Marks where a chip goes in the Markdown (private use characters). */
const CHIP_START = '\uE000';
const CHIP_END = '\uE001';
const CHIP = /\uE000(\d+)\uE001/g;

/**
 * A sent message's text rendered as Markdown (see
 * {@link renderPromptMarkdown}), its references as chips in place.
 */
@Component({
  selector: 'app-message-text',
  template: '',
  host: { class: 'markdown message-markdown' },
})
export class MessageText {
  readonly text = input.required<string>();
  readonly references = input<readonly MessageReference[]>([]);
  /** Name the repository of `#12` (the session has several). */
  readonly showRepository = input(false);
  protected readonly segments = computed(() =>
    messageSegments(this.text(), this.references()),
  );

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly application = inject(ApplicationRef);
  private readonly environment = inject(EnvironmentInjector);
  private readonly injector = inject(Injector);
  private chips: ComponentRef<ReferenceChip>[] = [];

  constructor() {
    effect(() => this.render(this.segments(), this.showRepository()));
    inject(DestroyRef).onDestroy(() => this.removeChips());
  }

  private render(segments: Segment[], showRepository: boolean): void {
    this.removeChips();
    const source = segments
      .map((segment, index) =>
        segment.kind === 'chip'
          ? `${CHIP_START}${index}${CHIP_END}`
          : segment.text.replace(/[\uE000\uE001]/g, ''),
      )
      .join('');
    const html =
      this.sanitizer.sanitize(
        SecurityContext.HTML,
        renderPromptMarkdown(source),
      ) ?? '';
    const host = this.host.nativeElement;
    host.innerHTML = html;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode()) {
      if ((walker.currentNode as Text).data.includes(CHIP_START)) {
        texts.push(walker.currentNode as Text);
      }
    }
    for (const node of texts) {
      const parts = node.data.split(CHIP);
      const fragment = document.createDocumentFragment();
      parts.forEach((part, index) => {
        // split() with a group: text, index, text, index, ..., text.
        if (index % 2 === 0) {
          if (part) {
            fragment.append(part);
          }
          return;
        }
        const segment = segments[Number(part)];
        if (segment?.kind !== 'chip') {
          return;
        }
        const element = document.createElement('app-reference-chip');
        fragment.append(element);
        const chip = createComponent(ReferenceChip, {
          environmentInjector: this.environment,
          elementInjector: this.injector,
          hostElement: element,
        });
        chip.setInput('chip', segment.chip);
        chip.setInput('showRepository', showRepository);
        this.application.attachView(chip.hostView);
        this.chips.push(chip);
      });
      node.replaceWith(fragment);
    }
  }

  private removeChips(): void {
    for (const chip of this.chips) {
      chip.destroy();
    }
    this.chips = [];
  }
}
