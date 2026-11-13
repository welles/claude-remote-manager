import type {
  SessionDirectoryDto,
  SessionDto,
} from '@claude-remote-manager/shared-types';

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
  waitingFor: 'message',
  slug: 'reply-with-pong-abc123',
  pendingMessage: null,
  directories: [
    {
      role: 'main',
      kind: 'clone',
      path: '/workspace/sessions/reply-with-pong-abc123/acme/app',
      state: 'ready',
      repository: {
        id: 'r1',
        fullName: 'acme/app',
        local: false,
        github: false,
      },
      branch: 'claude/reply-with-pong-abc123',
      baseBranch: 'main',
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
      setupStatus: 'none',
      pushedCommit: null,
      pushedAt: null,
    },
  ],
  cwd: '/workspace/sessions/reply-with-pong-abc123/acme/app',
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
  pullRequests: [],
  autoclosedAt: null,
  previews: [],
  ...overrides,
});

/** A directory of a session (the main clone of {@link sessionDto}). */
export const sessionDirectory = (
  overrides: Partial<SessionDirectoryDto> = {},
): SessionDirectoryDto => ({
  ...sessionDto().directories[0],
  ...overrides,
});
