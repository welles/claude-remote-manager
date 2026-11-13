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
  template: `
    @let d = diff();
    <div class="head">
      <code class="path" [title]="d.path">{{ label() ?? d.path }}</code>
      <span class="status">{{ statusLabel() }}</span>
      <span class="counts"
        ><span class="added">+{{ d.additions }}</span>
        <span class="removed">−{{ d.deletions }}</span></span
      >
    </div>
    @if (d.approximate) {
      <p class="hint" data-testid="diff-approximate">
        From the tool's input: line numbers count from the changed text.
      </p>
    }
    <app-diff-view [diff]="d" [layout]="layout()" [limit]="limit()" />
  `,
  styles: `
    :host {
      display: block;
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 2px 8px;
      margin-bottom: 4px;
    }
    .path {
      overflow-wrap: anywhere;
    }
    .status,
    .hint {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }
    .hint {
      margin: 0 0 4px;
    }
    .added {
      color: var(--app-diff-add-fg);
    }
    .removed {
      color: var(--app-diff-del-fg);
    }
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
