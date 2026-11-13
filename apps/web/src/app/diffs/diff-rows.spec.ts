import { splitRows, unifiedRows } from './diff-rows';
import { fileDiff } from './testing/file-diffs';

describe('diff rows', () => {
  it('numbers unified lines from the hunk starts', () => {
    expect(unifiedRows(fileDiff())).toEqual([
      { kind: 'hunk', text: '@@ -10,3 +10,4 @@' },
      {
        kind: 'line',
        type: 'context',
        oldNumber: 10,
        newNumber: 10,
        text: 'const a = 1;',
      },
      {
        kind: 'line',
        type: 'del',
        oldNumber: 11,
        newNumber: null,
        text: 'const b = 2;',
      },
      {
        kind: 'line',
        type: 'add',
        oldNumber: null,
        newNumber: 11,
        text: 'const b = 3;',
      },
      {
        kind: 'line',
        type: 'add',
        oldNumber: null,
        newNumber: 12,
        text: 'const c = 4;',
      },
      {
        kind: 'line',
        type: 'context',
        oldNumber: 12,
        newNumber: 13,
        text: 'export {};',
      },
    ]);
  });

  it('pairs removed and added lines side by side', () => {
    const rows = splitRows(fileDiff());
    expect(rows.slice(1)).toEqual([
      {
        kind: 'pair',
        left: { type: 'context', number: 10, text: 'const a = 1;' },
        right: { type: 'context', number: 10, text: 'const a = 1;' },
      },
      {
        kind: 'pair',
        left: { type: 'del', number: 11, text: 'const b = 2;' },
        right: { type: 'add', number: 11, text: 'const b = 3;' },
      },
      {
        kind: 'pair',
        left: null,
        right: { type: 'add', number: 12, text: 'const c = 4;' },
      },
      {
        kind: 'pair',
        left: { type: 'context', number: 12, text: 'export {};' },
        right: { type: 'context', number: 13, text: 'export {};' },
      },
    ]);
  });

  it('keeps "no newline" notes with their side', () => {
    const rows = splitRows(
      fileDiff({
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ['-a', '\\ No newline at end of file', '+b'],
          },
        ],
      }),
    );
    expect(rows.slice(1)).toEqual([
      {
        kind: 'pair',
        left: { type: 'del', number: 1, text: 'a' },
        right: { type: 'add', number: 1, text: 'b' },
      },
      {
        kind: 'pair',
        left: {
          type: 'note',
          number: null,
          text: ' No newline at end of file',
        },
        right: null,
      },
    ]);
  });
});
