import type {
  CommitSummary,
  CommitsAddedEvent,
} from '@claude-remote-manager/shared-types';

/** A commit as the API lists it. */
export const commitSummary = (
  overrides: Partial<CommitSummary> = {},
): CommitSummary => ({
  sha: '1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d',
  parents: ['0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f'],
  subject: 'feat: add the thing',
  body: '',
  authorName: 'Test',
  authoredAt: '2026-11-26T10:00:00.000Z',
  files: [
    {
      path: 'src/a.ts',
      oldPath: null,
      binary: false,
      additions: 3,
      deletions: 1,
    },
  ],
  fileCount: 1,
  additions: 3,
  deletions: 1,
  ...overrides,
});

/** New commits on a session branch, as the history reports them. */
export const commitsAdded = (
  overrides: Partial<CommitsAddedEvent> = {},
): CommitsAddedEvent => ({
  type: 'commits.added',
  seq: 1,
  at: '2026-11-26T10:00:01.000Z',
  toolUseId: 't1',
  repositoryId: 'r1',
  repository: 'acme/app',
  branch: 'claude/x',
  previousHead: '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f',
  head: '1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d',
  rewritten: false,
  commits: [commitSummary()],
  commitCount: 1,
  ...overrides,
});
