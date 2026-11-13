import type { FileDiff } from '@claude-remote-manager/shared-types';

/** A small modification of one file, for tests. */
export const fileDiff = (overrides: Partial<FileDiff> = {}): FileDiff => ({
  path: '/work/app/src/a.ts',
  oldPath: null,
  status: 'modified',
  binary: false,
  additions: 2,
  deletions: 1,
  hunks: [
    {
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 4,
      lines: [
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
        '+const c = 4;',
        ' export {};',
      ],
    },
  ],
  truncated: false,
  approximate: false,
  ...overrides,
});
