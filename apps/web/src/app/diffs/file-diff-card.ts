import { Component, computed, input } from '@angular/core';
import type { FileDiff } from '@claude-remote-manager/shared-types';
import type { DiffLayout } from './diff-rows';
import { DiffView } from './diff-view';

const STATUS_LABELS: Record<FileDiff['status'], string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  type_changed: 'type changed',
};

/**
 * A file change as shown in the conversation and in approval cards: path,
 * counts and the first lines of the diff, expandable to all of them.
 */
@Component({
  selector: 'app-file-diff-card',
  imports: [DiffView],
  host: { class: 'block' },
  template: `
    @let d = diff();
    <div class="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <code class="path wrap-anywhere" [title]="d.path">{{
        label() ?? d.path
      }}</code>
      <span class="type-body-small text-on-surface-variant">{{
        statusLabel()
      }}</span>
      <span
        ><span class="text-(--app-diff-add-fg)">+{{ d.additions }}</span>
        <span class="text-(--app-diff-del-fg)">−{{ d.deletions }}</span></span
      >
    </div>
    @if (d.approximate) {
      <p class="hint-text mb-1" data-testid="diff-approximate">
        From the tool's input: line numbers count from the changed text.
      </p>
    }
    <app-diff-view [diff]="d" [layout]="layout()" [limit]="limit()" />
  `,
})
export class FileDiffCard {
  readonly diff = input.required<FileDiff>();
  /** Shorter name of the file, e.g. relative to the session's directory. */
  readonly label = input<string | null>(null);
  readonly layout = input<DiffLayout>('unified');
  readonly limit = input<number | null>(12);

  protected readonly statusLabel = computed(
    () => STATUS_LABELS[this.diff().status],
  );
}
