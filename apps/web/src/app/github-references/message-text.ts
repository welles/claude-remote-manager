import { Component, computed, input } from '@angular/core';
import {
  parseReferences,
  type MessageReference,
} from '@claude-remote-manager/shared-types';
import { ReferenceChip } from './reference-chip';
import { chipOf, type ReferenceChipModel } from './references';

type Segment =
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

/** A sent message's text with its references as chips. */
@Component({
  selector: 'app-message-text',
  imports: [ReferenceChip],
  // Whitespace matters: the text keeps its line breaks (pre-wrap).
  template: `@for (segment of segments(); track $index) {
    @if (segment.kind === 'chip') {
      <app-reference-chip
        [chip]="segment.chip"
        [showRepository]="showRepository()"
      />
    } @else {
      <ng-container>{{ segment.text }}</ng-container>
    }
  }`,
})
export class MessageText {
  readonly text = input.required<string>();
  readonly references = input<readonly MessageReference[]>([]);
  /** Name the repository of `#12` (the session has several). */
  readonly showRepository = input(false);
  protected readonly segments = computed(() =>
    messageSegments(this.text(), this.references()),
  );
}
