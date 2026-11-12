import type { NewSession, NewSessionDirectory } from '../session.repository';

/** A plain directory of a session (no worktree, no project). */
export const plainDirectory = (path: string): NewSessionDirectory => ({
  path,
  repositoryId: null,
  branch: null,
  baseBranch: null,
  state: 'ready',
  setupStatus: 'none',
});

/** A new session in plain directories, for repository tests. */
export const newSessionRecord = (
  overrides: Partial<NewSession> = {},
): NewSession => ({
  id: 'session-1',
  title: 'Title',
  model: 'haiku',
  permissionMode: 'default',
  status: 'running',
  slug: null,
  pendingMessage: null,
  directories: [plainDirectory('/work')],
  ...overrides,
});
