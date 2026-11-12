import type { SessionDto } from '@claude-remote-manager/shared-types';

/** A session as the API returns it, for tests. */
export const sessionDto = (
  overrides: Partial<SessionDto> = {},
): SessionDto => ({
  id: 's1',
  sdkSessionId: null,
  title: 'Reply with pong',
  model: 'haiku',
  permissionMode: 'default',
  status: 'waiting',
  cwd: '/work',
  additionalDirectories: [],
  lastError: null,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  usage: {
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsd: 0.0123,
  },
  context: null,
  ...overrides,
});
