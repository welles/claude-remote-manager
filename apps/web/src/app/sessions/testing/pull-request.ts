import type { PullRequestDto } from '@claude-remote-manager/shared-types';

/** A pull request of a session as the API returns it, for tests. */
export const pullRequestDto = (
  overrides: Partial<PullRequestDto> = {},
): PullRequestDto => ({
  id: 1,
  repositoryId: 'r1',
  repository: 'acme/app',
  number: 7,
  url: 'https://github.com/acme/app/pull/7',
  title: 'Fix login',
  state: 'open',
  draft: false,
  headBranch: 'claude/reply-with-pong-abc123',
  baseBranch: 'main',
  createdBy: 'claude',
  openedAt: '2026-01-01T10:00:00.000Z',
  closedAt: null,
  mergedAt: null,
  syncedAt: '2026-01-01T10:00:00.000Z',
  automation: {
    autofix: false,
    autoclose: false,
    automerge: {
      enabled: false,
      held: null,
      failure: null,
      waiting: null,
    },
    attempts: 0,
    maxAttempts: 3,
    gaveUp: false,
    running: false,
    lastRunAt: null,
    lastTrigger: null,
  },
  ...overrides,
});
