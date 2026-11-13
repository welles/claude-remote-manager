import type { FileDiff } from '@claude-remote-manager/shared-types';

/** How a diff is laid out: one column, or old and new side by side. */
export type DiffLayout = 'unified' | 'split';

export type LineType = 'context' | 'add' | 'del' | 'note';

/** A line of the old or new file (one side of a split row). */
export interface DiffCell {
  type: LineType;
  number: number | null;
  text: string;
}

export type UnifiedRow =
  | { kind: 'hunk'; text: string }
  | {
      kind: 'line';
      type: LineType;
      oldNumber: number | null;
      newNumber: number | null;
      text: string;
    };

export type SplitRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'pair'; left: DiffCell | null; right: DiffCell | null };

const hunkHeader = (hunk: FileDiff['hunks'][number]) =>
  `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;

function lineType(line: string): LineType {
  switch (line[0]) {
    case '+':
      return 'add';
    case '-':
      return 'del';
    case '\\':
      return 'note';
    default:
      return 'context';
  }
}

/** Rows of the unified layout, with old and new line numbers. */
export function unifiedRows(diff: FileDiff): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  for (const hunk of diff.hunks) {
    rows.push({ kind: 'hunk', text: hunkHeader(hunk) });
    let oldNumber = hunk.oldStart;
    let newNumber = hunk.newStart;
    for (const line of hunk.lines) {
      const type = lineType(line);
      const text = line.slice(1);
      switch (type) {
        case 'add':
          rows.push({ kind: 'line', type, oldNumber: null, newNumber, text });
          newNumber++;
          break;
        case 'del':
          rows.push({ kind: 'line', type, oldNumber, newNumber: null, text });
          oldNumber++;
          break;
        case 'note':
          rows.push({
            kind: 'line',
            type,
            oldNumber: null,
            newNumber: null,
            text,
          });
          break;
        default:
          rows.push({ kind: 'line', type, oldNumber, newNumber, text });
          oldNumber++;
          newNumber++;
      }
    }
  }
  return rows;
}

/**
 * Rows of the side-by-side layout: context on both sides, runs of removed
 * lines paired with the added lines that follow them.
 */
export function splitRows(diff: FileDiff): SplitRow[] {
  const rows: SplitRow[] = [];
  for (const hunk of diff.hunks) {
    rows.push({ kind: 'hunk', text: hunkHeader(hunk) });
    let oldNumber = hunk.oldStart;
    let newNumber = hunk.newStart;
    let removed: DiffCell[] = [];
    let added: DiffCell[] = [];
    const flush = () => {
      for (let i = 0; i < Math.max(removed.length, added.length); i++) {
        rows.push({
          kind: 'pair',
          left: removed[i] ?? null,
          right: added[i] ?? null,
        });
      }
      removed = [];
      added = [];
    };
    for (const line of hunk.lines) {
      const type = lineType(line);
      const text = line.slice(1);
      if (type === 'del') {
        if (added.length > 0) {
          flush();
        }
        removed.push({ type, number: oldNumber++, text });
      } else if (type === 'add') {
        added.push({ type, number: newNumber++, text });
      } else if (type === 'note') {
        // Belongs to the line before it.
        const cell: DiffCell = { type, number: null, text };
        if (added.length > 0) {
          added.push(cell);
        } else if (removed.length > 0) {
          removed.push(cell);
        } else {
          rows.push({ kind: 'pair', left: cell, right: cell });
        }
      } else {
        flush();
        rows.push({
          kind: 'pair',
          left: { type, number: oldNumber++, text },
          right: { type, number: newNumber++, text },
        });
      }
    }
    flush();
  }
  return rows;
}
