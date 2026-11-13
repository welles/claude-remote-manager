import type {
  FileDiff,
  SessionEventInput,
} from '@claude-remote-manager/shared-types';
import { capHunks, countChanges, diffTexts } from './file-diff';
import {
  diffFromToolInput,
  diffFromToolResult,
  proposedDiff,
  withInputDiffs,
} from './tool-diffs';

const EDIT_RESULT = {
  filePath: '/work/a.ts',
  oldString: 'two',
  newString: 'TWO',
  originalFile: 'one\ntwo\nthree\n',
  structuredPatch: [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [' one', '-two', '+TWO', ' three'],
    },
  ],
  userModified: false,
  replaceAll: false,
};

describe('tool diffs', () => {
  it('takes Edit and Write diffs from Claude Code’s structured result', () => {
    expect(
      diffFromToolResult('Edit', { file_path: '/work/a.ts' }, EDIT_RESULT),
    ).toEqual({
      path: '/work/a.ts',
      oldPath: null,
      status: 'modified',
      binary: false,
      additions: 1,
      deletions: 1,
      hunks: EDIT_RESULT.structuredPatch,
      truncated: false,
      approximate: false,
    });
    // A new file: Claude Code reports no hunks, the content is all added.
    expect(
      diffFromToolResult(
        'Write',
        { file_path: '/work/new.md', content: 'a\nb\n' },
        {
          type: 'create',
          filePath: '/work/new.md',
          content: 'a\nb\n',
          structuredPatch: [],
          originalFile: null,
        },
      ),
    ).toMatchObject({
      path: '/work/new.md',
      status: 'added',
      additions: 2,
      deletions: 0,
      hunks: [{ oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }],
    });
    expect(
      diffFromToolResult(
        'Write',
        {},
        { ...EDIT_RESULT, type: 'update', content: 'x' },
      ),
    ).toMatchObject({ status: 'modified', additions: 1 });
  });

  it('ignores staged, unknown and malformed results', () => {
    expect(
      diffFromToolResult('Edit', {}, { ...EDIT_RESULT, staged: true }),
    ).toBeNull();
    expect(diffFromToolResult('Read', {}, EDIT_RESULT)).toBeNull();
    expect(diffFromToolResult('Edit', {}, 'Done')).toBeNull();
    expect(
      diffFromToolResult('Edit', {}, { ...EDIT_RESULT, structuredPatch: 'x' }),
    ).toBeNull();
  });

  it('diffs notebook cells from the result', () => {
    expect(
      diffFromToolResult(
        'NotebookEdit',
        { notebook_path: '/work/n.ipynb' },
        {
          notebook_path: '/work/n.ipynb',
          old_source: 'print(1)',
          new_source: 'print(2)',
          edit_mode: 'replace',
          cell_type: 'code',
        },
      ),
    ).toMatchObject({
      path: '/work/n.ipynb',
      approximate: true,
      additions: 1,
      deletions: 1,
    });
  });

  it('falls back to the input, marked approximate', () => {
    expect(
      diffFromToolInput('Edit', {
        file_path: '/work/a.ts',
        old_string: 'two',
        new_string: 'TWO\nmore',
      }),
    ).toMatchObject({
      path: '/work/a.ts',
      status: 'modified',
      approximate: true,
      additions: 2,
      deletions: 1,
    });
    expect(
      diffFromToolInput('Write', { file_path: '/w/b', content: 'x\ny' }),
    ).toMatchObject({ status: 'added', additions: 2, approximate: true });
    expect(diffFromToolInput('Bash', { command: 'ls' })).toBeNull();
    expect(diffFromToolInput('Edit', { file_path: '/w/a' })).toBeNull();
  });

  it('proposes changes against the current file with real line numbers', () => {
    const current = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
      '\n',
    );
    const edit = proposedDiff(
      'Edit',
      { file_path: '/w/a', old_string: 'line 15', new_string: 'LINE 15' },
      current,
    );
    expect(edit).toMatchObject({ approximate: false, additions: 1 });
    expect(edit?.hunks[0]).toMatchObject({ oldStart: 12, newStart: 12 });
    // replace_all replaces every occurrence.
    expect(
      proposedDiff(
        'Edit',
        {
          file_path: '/w/a',
          old_string: 'x',
          new_string: 'y',
          replace_all: true,
        },
        'x\nx\nx',
      ),
    ).toMatchObject({ additions: 3, deletions: 3 });
    // `$&` in the new text is not a replacement pattern.
    expect(
      proposedDiff(
        'Edit',
        { file_path: '/w/a', old_string: 'a', new_string: '$&$&' },
        'a',
      )?.hunks[0].lines,
    ).toEqual([
      '-a',
      '\\ No newline at end of file',
      '+$&$&',
      '\\ No newline at end of file',
    ]);
    expect(
      proposedDiff('Write', { file_path: '/w/new', content: 'n' }, null),
    ).toMatchObject({ status: 'added', approximate: false });
    expect(
      proposedDiff('Write', { file_path: '/w/a', content: 'a\nB' }, 'a\nb'),
    ).toMatchObject({ status: 'modified', additions: 1, deletions: 1 });
    // Unreadable file, or old text not found: from the input.
    expect(
      proposedDiff(
        'Edit',
        { file_path: '/w/a', old_string: 'zz', new_string: 'y' },
        undefined,
      ),
    ).toMatchObject({ approximate: true });
    expect(
      proposedDiff(
        'Edit',
        { file_path: '/w/a', old_string: 'zz', new_string: 'y' },
        'abc',
      ),
    ).toMatchObject({ approximate: true });
  });

  it('caps long diffs and keeps the full counts', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n');
    const diff = diffFromToolInput('Write', {
      file_path: '/w/big',
      content: big,
    });
    expect(diff).toMatchObject({ additions: 3000, truncated: true });
    expect(diff?.hunks.flatMap((hunk) => hunk.lines)).toHaveLength(2000);
    const capped = capHunks(
      [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: [' a', '-b', '+c'],
        },
        { oldStart: 9, oldLines: 1, newStart: 9, newLines: 1, lines: [' x'] },
      ],
      2,
    );
    expect(capped).toEqual({
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 1,
          lines: [' a', '-b'],
        },
      ],
      truncated: true,
    });
    expect(countChanges(capped.hunks)).toEqual({ additions: 0, deletions: 1 });
    expect(diffTexts('a', 'b')).toHaveLength(1);
  });

  it('adds input diffs to histories only where none is stored', () => {
    const item = (event: SessionEventInput) => ({ event, at: null });
    const call = (id: string, name = 'Edit') =>
      item({
        type: 'tool.call',
        messageId: 'm',
        toolUseId: id,
        name,
        input: { file_path: '/w/a', old_string: 'a', new_string: 'b' },
        parentToolUseId: null,
      });
    const result = (id: string, isError = false) =>
      item({
        type: 'tool.result',
        toolUseId: id,
        isError,
        content: '',
        truncated: false,
        parentToolUseId: null,
      });
    const stored = item({
      type: 'tool.diff',
      toolUseId: 't1',
      diff: diffFromToolInput('Edit', {
        file_path: '/w/a',
        old_string: 'a',
        new_string: 'b',
      }) as FileDiff,
      source: 'result',
      parentToolUseId: null,
    });
    const items = withInputDiffs(
      [
        call('t1'),
        result('t1'),
        stored,
        call('t2'),
        result('t2'),
        call('t3'),
        result('t3', true),
        call('t4', 'Read'),
        result('t4'),
      ],
      (event, at) => ({ event, at }),
    );
    expect(
      items.map(({ event }) =>
        event.type === 'tool.diff'
          ? `diff:${event.toolUseId}:${event.source}`
          : event.type,
      ),
    ).toEqual([
      'tool.call',
      'tool.result',
      'diff:t1:result',
      'tool.call',
      'tool.result',
      'diff:t2:input',
      'tool.call',
      'tool.result',
      'tool.call',
      'tool.result',
    ]);
  });
});
