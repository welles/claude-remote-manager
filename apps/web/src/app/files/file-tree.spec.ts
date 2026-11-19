import type { BrowsedDirectory } from '@claude-remote-manager/shared-types';
import { buildTree, rowKey, treeRows } from './file-tree';

const directory: BrowsedDirectory = {
  directory: 0,
  repository: 'acme/app',
  path: '/w/acme/app',
  files: ['README.md', 'src/b.ts', 'src/a.ts', 'src/lib/c.ts', 'docs/x.md'],
  truncated: false,
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
      ['src/b.ts', 0],
      ['src/a.ts', 0],
      ['src/lib/c.ts', 0],
    ]);
    expect(rows([], 'nothing')).toEqual([]);
  });
});
