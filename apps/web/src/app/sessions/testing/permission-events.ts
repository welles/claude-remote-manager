import type {
  PermissionRequestEvent,
  PermissionResolvedEvent,
} from '@claude-remote-manager/shared-types';

/** An approval request as the server sends it, for tests. */
export const permissionRequest = (
  overrides: Partial<PermissionRequestEvent> = {},
): PermissionRequestEvent => ({
  type: 'permission.request',
  seq: 1,
  at: '2026-01-01T00:00:00Z',
  requestId: 'p1',
  toolUseId: 't1',
  toolName: 'Bash',
  input: { command: 'rm -r build', description: 'Clean the build' },
  kind: 'tool',
  title: 'Claude wants to run rm -r build',
  description: null,
  displayName: null,
  decisionReason: null,
  blockedPath: null,
  agentId: null,
  gitPushes: [],
  pullRequest: null,
  sessionAllow: null,
  questions: null,
  plan: null,
  ...overrides,
});

/** The resolution of {@link permissionRequest}. */
export const permissionResolved = (
  overrides: Partial<PermissionResolvedEvent> = {},
): PermissionResolvedEvent => ({
  type: 'permission.resolved',
  seq: 2,
  at: '2026-01-01T00:00:01Z',
  requestId: 'p1',
  toolUseId: 't1',
  decision: 'allow',
  scope: 'once',
  cause: 'user',
  message: null,
  answers: null,
  mode: null,
  sessionAllow: null,
  ...overrides,
});
