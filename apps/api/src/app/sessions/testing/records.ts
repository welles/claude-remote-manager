import type { NewSession, NewSessionDirectory } from '../session.repository';

/** A plain directory of a session (no clone, no scratch directory). */
export const plainDirectory = (path: string): NewSessionDirectory => ({
  path,
  kind: 'directory',
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
