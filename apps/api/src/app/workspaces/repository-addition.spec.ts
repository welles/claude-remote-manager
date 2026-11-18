import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { SessionDto } from '@claude-remote-manager/shared-types';
import { git } from '../git/testing/git-fixtures';
import { ADD_REPOSITORY_TOOL_NAME } from '../sessions/approval-grants';
import { SessionEventRepository } from '../sessions/session-event.repository';
import { additionResult } from '../sessions/sessions.service';
import {
  FakeRun,
  flush,
  resultMessage,
  waitFor,
} from '../sessions/testing/fake-agent';
import { WorkspaceHarness } from './testing/workspace-harness';

describe('adding repositories to a running session', () => {
  let harness: WorkspaceHarness;

  beforeEach(async () => {
    harness = new WorkspaceHarness();
    await harness.start();
  });

  afterEach(() => harness.close());

  /** A session on acme/app whose first turn has ended (process idle). */
  async function idleSession(): Promise<{ session: SessionDto; run: FakeRun }> {
    const main = await harness.addRepository('acme', 'app');
    const session = await harness.service.create({
      prompt: 'Do the work',
      repositories: [{ repositoryId: main.id }],
    });
    await harness.prepared(session.id);
    const run = harness.runner.last;
    run.emit(resultMessage(10, 0.01));
    await waitFor(() => harness.service.get(session.id).status === 'waiting');
    return { session, run };
  }

  const clonePath = (session: SessionDto, owner: string, name: string) =>
    join(harness.config.sessionsDir, session.slug ?? '', owner, name);

  /** Waits until no repository is being added any more. */
  const settled = (sessionId: string) =>
    waitFor(() =>
      harness.service
        .get(sessionId)
        .directories.every((d) => d.addition?.state !== 'preparing'),
    );

  const added = (sessionId: string) =>
    harness.service
      .get(sessionId)
      .directories.find((directory) => directory.addition);

  it('adds a repository by control: own clone on the session branch, setup, then Claude gets it', async () => {
    const { session, run } = await idleSession();
    const lib = await harness.addRepository(
      'acme',
      'lib',
      'echo "setting up $CRM_REPOSITORY"; test -d .git',
    );
    const dto = await harness.service.addRepository(session.id, {
      repositoryId: lib.id,
    });
    expect(dto.directories.at(-1)).toMatchObject({
      role: 'additional',
      state: 'pending',
      addition: { by: 'user', state: 'preparing', error: null },
    });
    await settled(session.id);

    const path = clonePath(session, 'acme', 'lib');
    const directory = added(session.id);
    expect(directory).toMatchObject({
      path,
      state: 'ready',
      branch: `claude/${session.slug}`,
      baseBranch: 'main',
      baseCommit: await git(lib.origin, 'rev-parse', 'main'),
      setupStatus: 'succeeded',
      addition: { by: 'user', state: 'ready', error: null },
    });
    expect(await git(path, 'symbolic-ref', '--short', 'HEAD')).toBe(
      `claude/${session.slug}`,
    );
    expect(await git(path, 'config', 'user.name')).toBe('Test Author');
    // The running process got it as a working directory at once.
    expect(run.addedDirectories).toEqual([path]);
    expect(harness.service.get(session.id).additionalDirectories).toEqual([
      path,
    ]);

    // The history shows one addition: add, fetch, clone, setup, add.
    const progress = harness.eventsOfType(session.id, 'prepare.progress');
    const addition = progress.find((event) => event.step === 'add')?.addition;
    expect(addition).toEqual(expect.any(String));
    const steps = progress
      .filter((event) => event.addition === addition)
      .map((event) => `${event.step}:${event.state}`);
    expect(steps).toEqual([
      'add:started',
      'fetch:started',
      'fetch:succeeded',
      'clone:started',
      'clone:succeeded',
      'add:succeeded',
    ]);
    expect(
      harness
        .eventsOfType(session.id, 'setup.result')
        .filter((event) => event.addition === addition)
        .map((event) => event.state),
    ).toEqual(['started', 'succeeded']);
    // Stored, so a reloaded history shows it too.
    expect(
      new SessionEventRepository(harness.db)
        .list(session.id)
        .some(
          ({ event }) =>
            event.type === 'prepare.progress' && event.step === 'add',
        ),
    ).toBe(true);

    // Claude learns path, branch and base with the next message, once.
    await harness.service.send(session.id, { text: 'Now both' });
    const note = run.sent.at(-1)?.note?.text ?? '';
    expect(note).toContain('acme/lib');
    expect(note).toContain(path);
    expect(note).toContain(`claude/${session.slug}`);
    expect(note).toContain('created from main');
    run.emit(resultMessage(10, 0.01, { num_turns: 0 }));
    run.emit(resultMessage(20, 0.02));
    await waitFor(() => harness.service.get(session.id).status === 'waiting');
    await harness.service.send(session.id, { text: 'Again' });
    expect(run.sent.at(-1)?.note).toBeUndefined();
  });

  it('gives a repository added while no process runs to the next process', async () => {
    const { session, run } = await idleSession();
    run.close();
    await flush();
    const lib = await harness.addRepository('acme', 'lib');
    await harness.service.addRepository(session.id, {
      repositoryId: lib.id,
    });
    await settled(session.id);
    await harness.service.send(session.id, { text: 'Continue' });
    await waitFor(() => harness.runner.runs.length === 2);
    const next = harness.runner.last;
    const path = clonePath(session, 'acme', 'lib');
    expect(next.options.additionalDirectories).toEqual([path]);
    expect(next.sent[0].note?.text).toContain(path);
  });

  it('refuses repositories that are part of the session and checks the request', async () => {
    const { session } = await idleSession();
    const main = harness.sessions.require(session.id).directories[0];
    await expect(
      harness.service.addRepository(session.id, {
        repositoryId: main.repositoryId,
      }),
    ).rejects.toThrow('acme/app is already part of this session');
    await expect(
      harness.service.addRepository(session.id, { repositoryId: 'nope' }),
    ).rejects.toThrow('repositoryId must be a UUID');
    const lib = await harness.addRepository('acme', 'lib');
    await expect(
      harness.service.addRepository(session.id, {
        repositoryId: lib.id,
        baseBranch: '../evil',
      }),
    ).rejects.toThrow('not a valid branch name');
    harness.service.setArchived(session.id, new Date());
    await expect(
      harness.service.addRepository(session.id, { repositoryId: lib.id }),
    ).rejects.toThrow('archived');
  });

  it('leaves nothing behind when the clone fails; the session stays usable, retry and remove work', async () => {
    const { session, run } = await idleSession();
    const lib = await harness.addRepository('acme', 'lib');
    await harness.service.addRepository(session.id, {
      repositoryId: lib.id,
      baseBranch: 'missing',
    });
    await settled(session.id);
    const path = clonePath(session, 'acme', 'lib');
    expect(added(session.id)).toMatchObject({
      state: 'failed',
      addition: {
        state: 'failed',
        error: expect.stringContaining('Branch missing does not exist'),
      },
    });
    expect(existsSync(path)).toBe(false);
    expect(
      existsSync(
        join(harness.config.sessionsDir, session.slug ?? '', 'acme', 'app'),
      ),
    ).toBe(true);
    expect(run.addedDirectories).toEqual([]);
    expect(
      harness.eventsOfType(session.id, 'prepare.progress').at(-1),
    ).toMatchObject({ step: 'add', state: 'failed' });
    // The session goes on without it.
    await harness.service.send(session.id, { text: 'Go on' });
    expect(run.sent.at(-1)).toMatchObject({ text: 'Go on' });
    expect(run.sent.at(-1)?.note).toBeUndefined();
    run.emit(resultMessage(20, 0.02));
    await waitFor(() => harness.service.get(session.id).status === 'waiting');

    // Retry fails again (same base branch); remove forgets it.
    await harness.service.retryAddition(session.id, lib.id);
    await settled(session.id);
    expect(added(session.id)?.addition?.state).toBe('failed');
    await harness.service.removeAddition(session.id, lib.id);
    expect(added(session.id)).toBeUndefined();
    // And it can be added again.
    await harness.service.addRepository(session.id, { repositoryId: lib.id });
    await settled(session.id);
    expect(added(session.id)?.addition?.state).toBe('ready');
    expect(run.addedDirectories).toEqual([path]);
  });

  it('holds a repository whose setup script fails; run again, use anyway or remove', async () => {
    const { session, run } = await idleSession();
    const lib = await harness.addRepository('acme', 'lib', 'test -f ready');
    await harness.service.addRepository(session.id, { repositoryId: lib.id });
    await settled(session.id);
    const path = clonePath(session, 'acme', 'lib');
    expect(added(session.id)).toMatchObject({
      state: 'ready',
      setupStatus: 'failed',
      addition: { state: 'held', error: 'The setup script failed' },
    });
    expect(existsSync(path)).toBe(true);
    expect(run.addedDirectories).toEqual([]);
    expect(harness.service.get(session.id).additionalDirectories).toEqual([]);
    // Messages still go to Claude.
    await harness.service.send(session.id, { text: 'Meanwhile' });
    expect(run.sent.at(-1)?.note).toBeUndefined();
    run.emit(resultMessage(20, 0.02));
    await waitFor(() => harness.service.get(session.id).status === 'waiting');

    // Run again: still failing; use anyway gives it to Claude.
    await harness.service.retryAddition(session.id, lib.id);
    await settled(session.id);
    expect(added(session.id)?.addition?.state).toBe('held');
    await harness.service.acceptAddition(session.id, lib.id);
    expect(added(session.id)?.addition?.state).toBe('ready');
    expect(run.addedDirectories).toEqual([path]);
    await expect(
      harness.service.removeAddition(session.id, lib.id),
    ).rejects.toThrow('Only a repository whose addition failed or is held');
  });

  it('removes a held clone from disk', async () => {
    const { session } = await idleSession();
    const lib = await harness.addRepository('other', 'lib', 'exit 1');
    await harness.service.addRepository(session.id, { repositoryId: lib.id });
    await settled(session.id);
    const path = clonePath(session, 'other', 'lib');
    expect(existsSync(path)).toBe(true);
    await harness.service.removeAddition(session.id, lib.id);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(path, '..'))).toBe(false);
    expect(added(session.id)).toBeUndefined();
  });

  it('restarts an idle Claude Code that cannot add directories; the next message goes to the new one', async () => {
    const { session, run } = await idleSession();
    run.failAddDirectories = new Error('unknown control request');
    const lib = await harness.addRepository('acme', 'lib');
    await harness.service.addRepository(session.id, { repositoryId: lib.id });
    await settled(session.id);
    expect(run.closed).toBe(true);
    // Sent right away, while the old process may still be closing.
    await harness.service.send(session.id, { text: 'Go on' });
    await waitFor(() => harness.runner.runs.length === 2);
    const path = clonePath(session, 'acme', 'lib');
    expect(harness.runner.last.options.additionalDirectories).toEqual([path]);
    expect(harness.runner.last.sent[0]).toMatchObject({ text: 'Go on' });
    expect(harness.runner.last.sent[0].note?.text).toContain(path);
  });

  it('adds directories during a turn right away', async () => {
    const main = await harness.addRepository('acme', 'app');
    const session = await harness.service.create({
      prompt: 'Do the work',
      repositories: [{ repositoryId: main.id }],
    });
    await harness.prepared(session.id);
    const run = harness.runner.last;
    expect(harness.service.get(session.id).status).toBe('running');
    const lib = await harness.addRepository('acme', 'lib');
    await harness.service.addRepository(session.id, { repositoryId: lib.id });
    await settled(session.id);
    expect(run.addedDirectories).toEqual([clonePath(session, 'acme', 'lib')]);
    expect(run.closed).toBe(false);
  });

  describe('the tool add_repository', () => {
    const call = (
      run: FakeRun,
      input: Record<string, unknown>,
      toolUseID = 'tool-add',
    ) =>
      run.options.canUseTool(ADD_REPOSITORY_TOOL_NAME, input, {
        signal: new AbortController().signal,
        toolUseID,
        requestId: 'r1',
        mcpServer: { name: 'crm', source: 'sdk' },
      } as never) as Promise<PermissionResult>;
    const tool = (run: FakeRun) => {
      const found = run.options.tools?.find(
        (entry) => entry.name === 'add_repository',
      );
      if (!found) {
        throw new Error('no add_repository tool');
      }
      return found;
    };
    const pending = async (sessionId: string) => {
      await waitFor(
        () => harness.service.pendingPermissions(sessionId).length > 0,
      );
      return harness.service.pendingPermissions(sessionId)[0];
    };

    /** A session in the middle of a turn. */
    async function runningSession() {
      const main = await harness.addRepository('acme', 'app');
      const session = await harness.service.create({
        prompt: 'Do the work',
        repositories: [{ repositoryId: main.id }],
      });
      await harness.prepared(session.id);
      return { session, run: harness.runner.last };
    }

    it('asks the user with what it adds, once only; then Claude works in the clone', async () => {
      const { session, run } = await runningSession();
      expect(tool(run).alwaysAsk).toBe(true);
      const lib = await harness.addRepository('acme', 'lib');
      const decision = call(run, {
        repository: 'acme/lib',
        reason: 'The <b>config</b> lives there',
      });
      const request = await pending(session.id);
      expect(request).toMatchObject({
        kind: 'tool',
        toolName: ADD_REPOSITORY_TOOL_NAME,
        sessionAllow: null,
        repositoryAddition: {
          source: 'url',
          repository: 'acme/lib',
          url: lib.origin,
          registered: true,
          baseBranch: null,
          reason: 'The <b>config</b> lives there',
        },
      });
      expect(harness.service.get(session.id)).toMatchObject({
        status: 'waiting',
        waitingFor: 'permission',
        pendingRequests: { kind: 'repository', count: 1 },
      });
      // Never for the whole session.
      await expect(
        harness.service.respondToPermission(session.id, request.requestId, {
          decision: 'allow',
          scope: 'session',
        }),
      ).rejects.toThrow('only be allowed once');
      await harness.service.respondToPermission(session.id, request.requestId, {
        decision: 'allow',
      });
      expect(await decision).toMatchObject({ behavior: 'allow' });

      const result = await tool(run).handler(
        { repository: 'acme/lib', reason: 'x' },
        { toolUseId: 'tool-add' },
      );
      const path = clonePath(session, 'acme', 'lib');
      expect(result.isError).toBe(false);
      expect(result.text).toContain(`Its clone is ${path}`);
      expect(result.text).toContain(`claude/${session.slug}`);
      expect(result.text).toContain('created from main');
      expect(run.addedDirectories).toEqual([path]);
      expect(added(session.id)?.addition).toMatchObject({
        by: 'claude',
        state: 'ready',
      });
      // Claude learnt it from the result: no note with the next message.
      expect(
        harness.sessions.require(session.id).directories.at(-1)?.addition
          ?.announce,
      ).toBe(false);
      // The approval is used up.
      const again = await tool(run).handler(
        { repository: 'acme/lib', reason: 'x' },
        { toolUseId: 'tool-add' },
      );
      expect(again).toMatchObject({ isError: true });
      expect(again.text).toContain('not approved');
    });

    it('adds nothing when the user denies or the call was never approved', async () => {
      const { session, run } = await runningSession();
      await harness.addRepository('acme', 'lib');
      const decision = call(run, { repository: 'acme/lib', reason: 'r' });
      const request = await pending(session.id);
      await harness.service.respondToPermission(session.id, request.requestId, {
        decision: 'deny',
        message: 'Not that one',
      });
      expect(await decision).toMatchObject({ behavior: 'deny' });
      const result = await tool(run).handler(
        { repository: 'acme/lib', reason: 'r' },
        { toolUseId: 'tool-add' },
      );
      expect(result).toMatchObject({ isError: true });
      expect(added(session.id)).toBeUndefined();
    });

    it('refuses without asking what the form would not allow', async () => {
      const { session, run } = await runningSession();
      const refusals: [Record<string, unknown>, string][] = [
        [
          { repository: 'acme/app', reason: 'r' },
          'already part of this session',
        ],
        [{ url: '/etc', reason: 'r' }, 'Local paths cannot be added'],
        [
          { url: 'file:///srv/repo', reason: 'r' },
          'Local paths cannot be added',
        ],
        [{ url: 'ext::sh -c id', reason: 'r' }, 'not accepted'],
        [{ repository: 'nobody/else', reason: 'r' }, 'neither registered'],
        [{ repository: 'local/none', reason: 'r' }, 'no local project'],
        [{ repository: 'acme/app' }, 'Say why'],
        [
          { repository: 'a/b', url: 'https://x.test/a/b', reason: 'r' },
          'not both',
        ],
        [
          { repository: 'acme/app', base_branch: 'a..b', reason: 'r' },
          'not a valid branch',
        ],
      ];
      for (const [input, message] of refusals) {
        const result = await call(run, input);
        expect([input, result.behavior]).toEqual([input, 'deny']);
        expect(result).toMatchObject({
          message: expect.stringContaining(message),
        });
      }
      expect(harness.approver.requests).toHaveLength(0);
      expect(added(session.id)).toBeUndefined();
    });

    it('offers repositories of the GitHub App by name', async () => {
      const installation = harness.github.addInstallation('octo');
      harness.github.addRepository(installation, 'tools');
      const { session, run } = await runningSession();
      void call(run, { repository: 'octo/tools', reason: 'r' });
      const request = await pending(session.id);
      expect(request.repositoryAddition).toMatchObject({
        source: 'github',
        repository: 'octo/tools',
        registered: false,
        defaultBranch: 'main',
      });
    });

    it('tells Claude truthfully when the clone fails or the setup is held', async () => {
      const { session, run } = await runningSession();
      await harness.addRepository('acme', 'lib', 'exit 2');
      const decision = call(run, { repository: 'acme/lib', reason: 'r' });
      await harness.service.respondToPermission(
        session.id,
        (await pending(session.id)).requestId,
        { decision: 'allow' },
      );
      await decision;
      const result = await tool(run).handler(
        { repository: 'acme/lib', reason: 'r' },
        { toolUseId: 'tool-add' },
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain('not available to you yet');
      expect(run.addedDirectories).toEqual([]);
      expect(
        additionResult(
          {
            state: 'failed',
            error: 'Branch x does not exist',
            directory: null,
          },
          'acme/x',
          false,
        ),
      ).toContain(
        'acme/x was not added: Branch x does not exist. The repository is not available',
      );
    });

    it('restarts a Claude Code that cannot add directories after the turn and continues', async () => {
      const { session, run } = await runningSession();
      run.failAddDirectories = new Error('unknown control request');
      await harness.addRepository('acme', 'lib');
      const decision = call(run, { repository: 'acme/lib', reason: 'r' });
      await harness.service.respondToPermission(
        session.id,
        (await pending(session.id)).requestId,
        { decision: 'allow' },
      );
      await decision;
      const result = await tool(run).handler(
        { repository: 'acme/lib', reason: 'r' },
        { toolUseId: 'tool-add' },
      );
      expect(result.text).toContain('end your turn now');
      expect(run.closed).toBe(false);
      // The turn ends: the process is closed and the session continues in
      // a new one, with the repository and the app's message.
      run.emit(resultMessage(10, 0.01));
      await waitFor(() => harness.runner.runs.length === 2);
      const next = harness.runner.last;
      const path = clonePath(session, 'acme', 'lib');
      expect(run.closed).toBe(true);
      expect(next.options.additionalDirectories).toEqual([path]);
      expect(next.sent[0].text).toContain(
        `The repository acme/lib is now available in this session at ${path}`,
      );
      expect(harness.service.get(session.id).status).toBe('running');
      const message = harness.eventsOfType(session.id, 'user.message').at(-1);
      expect(message).toMatchObject({ origin: 'app' });
    });
    it('keeps an Autofix run held in default across the restart', async () => {
      const main = await harness.addRepository('acme', 'app');
      const session = await harness.service.create({
        prompt: 'Do the work',
        permissionMode: 'auto',
        repositories: [{ repositoryId: main.id }],
      });
      await harness.prepared(session.id);
      const run = harness.runner.last;
      run.emit(resultMessage(5, 0.01));
      await waitFor(
        () => harness.service.get(session.id).waitingFor === 'message',
      );
      await harness.service.sendMessage(session.id, {
        text: 'Fix the failing checks',
        origin: 'app',
        holdAutoMode: true,
      });
      expect(run.switches).toEqual([{ permissionMode: 'default' }]);

      run.failAddDirectories = new Error('unknown control request');
      await harness.addRepository('acme', 'lib');
      const decision = call(run, { repository: 'acme/lib', reason: 'r' });
      await harness.service.respondToPermission(
        session.id,
        (await pending(session.id)).requestId,
        { decision: 'allow' },
      );
      await decision;
      await tool(run).handler(
        { repository: 'acme/lib', reason: 'r' },
        { toolUseId: 'tool-add' },
      );
      run.emit(resultMessage(10, 0.01));
      await waitFor(() => harness.runner.runs.length === 2);
      const next = harness.runner.last;
      // The old process never returned to auto; the new one starts held.
      expect(run.switches).toEqual([{ permissionMode: 'default' }]);
      expect(next.options.permissionMode).toBe('default');
      expect(harness.service.get(session.id)).toMatchObject({
        permissionMode: 'auto',
        permissionModeOverride: { mode: 'default', reason: 'autofix' },
      });

      // The continuation's turn ends the run: back to auto.
      next.emit(resultMessage(15, 0.01));
      await waitFor(() => next.switches.length > 0);
      expect(next.switches).toEqual([{ permissionMode: 'auto' }]);
      expect(harness.service.get(session.id).permissionModeOverride).toBeNull();
    });
  });

  it('keeps cleanup away while adding; ending the session stops the setup script', async () => {
    const { session } = await idleSession();
    const lib = await harness.addRepository('acme', 'lib', 'sleep 30');
    await harness.service.addRepository(session.id, { repositoryId: lib.id });
    await waitFor(() => added(session.id)?.setupStatus === 'running');
    expect(harness.service.busyReason(session.id)).toContain('being added');
    await expect(
      harness.service.addRepository(session.id, {
        repositoryId: (await harness.addRepository('acme', 'other')).id,
      }),
    ).rejects.toThrow('being added');
    await harness.service.end(session.id);
    await settled(session.id);
    expect(added(session.id)?.addition).toMatchObject({
      state: 'held',
      error: 'The setup script was stopped because the session was ended',
    });
    expect(harness.service.busyReason(session.id)).toBeNull();
  });

  it('rolls back an addition that a server stop cut off', async () => {
    const { session } = await idleSession();
    const lib = await harness.addRepository('acme', 'lib', 'sleep 30');
    await harness.service.addRepository(session.id, { repositoryId: lib.id });
    const path = clonePath(session, 'acme', 'lib');
    await waitFor(() => existsSync(join(path, '.git')));
    await waitFor(() => added(session.id)?.setupStatus === 'running');
    // A crash: the services start again without stopping cleanly.
    await harness.start();
    expect(added(session.id)).toMatchObject({
      state: 'failed',
      addition: {
        state: 'failed',
        error: expect.stringContaining('interrupted'),
      },
    });
    expect(existsSync(path)).toBe(false);
  });
});
