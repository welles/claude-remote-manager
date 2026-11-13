import type {
  PermissionRequestInput,
  PermissionResolvedInput,
  ToolApprovalRequest,
} from '../agent/tool-approval';
import { UserToolApprover } from './user-tool-approver';

describe('UserToolApprover', () => {
  let approver: UserToolApprover;
  let requested: PermissionRequestInput[];
  let resolved: PermissionResolvedInput[];

  beforeEach(() => {
    approver = new UserToolApprover();
    requested = [];
    resolved = [];
  });

  const ask = (sessionId = 's1', signal = new AbortController().signal) =>
    approver.decide({
      sessionId,
      toolName: 'Bash',
      input: { command: 'ls' },
      toolUseId: 't',
      title: null,
      description: null,
      displayName: null,
      decisionReason: null,
      blockedPath: null,
      agentId: null,
      mcpServer: null,
      gitPushes: [],
      pullRequest: null,
      suggestions: [],
      suppressAlwaysAllow: false,
      signal,
      onRequest: (event) => requested.push(event),
      onResolve: (event) => resolved.push(event),
    } satisfies ToolApprovalRequest);

  it('keeps a request pending until it is answered, once', async () => {
    const decision = ask();
    expect(approver.hasPending('s1')).toBe(true);
    expect(approver.pendingRequests('s1')).toEqual(requested);
    expect(approver.hasPending('s2')).toBe(false);
    const { requestId } = requested[0];

    // Another session cannot answer it.
    expect(approver.respond('s2', requestId, { decision: 'allow' })).toBeNull();
    expect(approver.respond('s1', requestId, { decision: 'allow' })).toEqual(
      resolved[0],
    );
    await expect(decision).resolves.toMatchObject({ behavior: 'allow' });
    expect(approver.respond('s1', requestId, { decision: 'deny' })).toBeNull();
    expect(resolved).toHaveLength(1);
    expect(approver.hasPending('s1')).toBe(false);
  });

  it('keeps a request pending after an invalid answer', () => {
    void ask();
    expect(() =>
      approver.respond('s1', requested[0].requestId, { decision: 'nope' }),
    ).toThrow();
    expect(approver.hasPending('s1')).toBe(true);
  });

  it('cancels on abort and per session', async () => {
    const controller = new AbortController();
    const aborted = ask('s1', controller.signal);
    const ended = ask('s1');
    const other = ask('s2');
    controller.abort();
    await expect(aborted).resolves.toMatchObject({
      behavior: 'deny',
      resolution: { cause: 'interrupted' },
    });
    expect(approver.cancelSession('s1', 'ended')).toBe(1);
    await expect(ended).resolves.toMatchObject({
      resolution: { cause: 'ended' },
    });
    expect(approver.hasPending('s2')).toBe(true);
    approver.cancelSession('s2', 'restart');
    await expect(other).resolves.toMatchObject({
      resolution: { cause: 'restart' },
    });
    expect(resolved.map((event) => event.cause)).toEqual([
      'interrupted',
      'ended',
      'restart',
    ]);
  });

  it('does not show a request whose signal fired already', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(ask('s1', controller.signal)).resolves.toMatchObject({
      behavior: 'deny',
    });
    expect(requested).toEqual([]);
    expect(approver.hasPending('s1')).toBe(false);
  });
});
