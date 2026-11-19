import type { BrowsedDirectory } from '@claude-remote-manager/shared-types';
import { buildTree, MAX_FOLDER_FILES, rowKey, treeRows } from './file-tree';

const directory: BrowsedDirectory = {
  directory: 0,
  repository: 'acme/app',
  path: '/w/acme/app',
  files: ['README.md', 'src/b.ts', 'src/a.ts', 'src/lib/c.ts', 'docs/x.md'],
  truncated: false,
  error: null,
};

const rows = (
  expanded: string[] = [],
  filter = '',
  changes: [string, 'added' | 'modified' | 'deleted'][] = [],
) =>
  treeRows(
    directory,
    buildTree(directory.files),
    new Set(expanded),
    new Map(changes),
    filter,
  );

describe('treeRows', () => {
  it('cuts long folders short until all are asked for', () => {
    const many: BrowsedDirectory = {
      ...directory,
      files: Array.from(
        { length: MAX_FOLDER_FILES + 5 },
        (_, i) => `f${i}.txt`,
      ),
    };
    const tree = buildTree(many.files);
    const shown = treeRows(many, tree, new Set(), new Map(), '');
    expect(shown).toHaveLength(MAX_FOLDER_FILES + 1);
    expect(shown.at(-1)).toMatchObject({ more: 5, name: '5 more files' });
    expect(
      treeRows(many, tree, new Set(), new Map(), '', new Set([rowKey(0, '')])),
    ).toHaveLength(MAX_FOLDER_FILES + 5);
  });

  it('shows folders first, then files, and opens expanded folders', () => {
    expect(rows().map((row) => [row.name, row.folder, row.depth])).toEqual([
      ['docs', true, 0],
      ['src', true, 0],
      ['README.md', false, 0],
    ]);
    expect(
      rows([rowKey(0, 'src'), rowKey(0, 'src/lib')]).map((row) => row.path),
    ).toEqual([
      'docs',
      'src',
      'src/lib',
      'src/lib/c.ts',
      'src/a.ts',
      'src/b.ts',
      'README.md',
    ]);
  });

  it('marks changed files and the folders above them', () => {
    const shown = rows([rowKey(0, 'src')], '', [
      [rowKey(0, 'src/lib/c.ts'), 'added'],
    ]);
    const by = (path: string) => shown.find((row) => row.path === path);
    expect(by('src')?.changedInside).toBe(true);
    expect(by('src/lib')?.changedInside).toBe(true);
    expect(by('docs')?.changedInside).toBe(false);
    expect(
      rows([rowKey(0, 'src'), rowKey(0, 'src/lib')], '', [
        [rowKey(0, 'src/lib/c.ts'), 'added'],
      ]).find((row) => row.path === 'src/lib/c.ts')?.change,
    ).toBe('added');
  });

  it('lists files matching every word of a filter, flat', () => {
    expect(rows([], 'src TS').map((row) => [row.name, row.depth])).toEqual([
      ['src/a.ts', 0],
      ['src/b.ts', 0],
      ['src/lib/c.ts', 0],
    ]);
    expect(rows([], 'nothing')).toEqual([]);
  });
});
