import { Component, computed, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type { FileDiff } from '@claude-remote-manager/shared-types';
import { splitRows, unifiedRows, type DiffLayout } from './diff-rows';

/**
 * The hunks of one file's diff, unified or side by side. With `limit`, only
 * that many rows are shown until the user expands it. Long lines scroll
 * horizontally inside the view; text is never interpreted as HTML.
 */
@Component({
  selector: 'app-diff-view',
  imports: [MatButtonModule],
  templateUrl: './diff-view.html',
  host: { class: 'block' },
})
export class DiffView {
  readonly diff = input.required<FileDiff>();
  readonly layout = input<DiffLayout>('unified');
  /** Rows shown before "Show all"; `null`: all. */
  readonly limit = input<number | null>(null);

  protected readonly expanded = signal(false);
  protected readonly unified = computed(() => unifiedRows(this.diff()));
  protected readonly split = computed(() => splitRows(this.diff()));
  protected readonly total = computed(() =>
    this.layout() === 'split' ? this.split().length : this.unified().length,
  );
  /** Rows to show now. */
  protected readonly shown = computed(() => {
    const limit = this.limit();
    return limit === null || this.expanded() ? this.total() : limit;
  });
  protected readonly sign = { context: ' ', add: '+', del: '-', note: ' ' };
}
