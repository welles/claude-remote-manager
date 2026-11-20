import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { SessionDto } from '@claude-remote-manager/shared-types';
import { commitFile, git } from '../git/testing/git-fixtures';
import {
  ADD_BRANCH_TOOL_NAME,
  ADD_REPOSITORY_TOOL_NAME,
  SWITCH_DIRECTORY_TOOL_NAME,
} from '../sessions/app-tools';
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

    it('asks the user with what it adds; then Claude works in the clone', async () => {
      const { session, run } = await runningSession();
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
      // Claude Code suggested no rule for the session.
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
      // The approval is used up: a repeated call is checked again.
      const again = await tool(run).handler(
        { repository: 'acme/lib', reason: 'x' },
        { toolUseId: 'tool-add' },
      );
      expect(again).toMatchObject({ isError: true });
      expect(again.text).toContain('already part of this session');
    });

    it('adds nothing when the user denies', async () => {
      const { session, run } = await runningSession();
      await harness.addRepository('acme', 'lib');
      const decision = call(run, { repository: 'acme/lib', reason: 'r' });
      const request = await pending(session.id);
      await harness.service.respondToPermission(session.id, request.requestId, {
        decision: 'deny',
        message: 'Not that one',
      });
      expect(await decision).toMatchObject({ behavior: 'deny' });
      expect(added(session.id)).toBeUndefined();
    });

    it('adds a repository without asking where the permission mode lets the call through', async () => {
      const { session, run } = await runningSession();
      await harness.addRepository('acme', 'lib');
      // Claude Code ran the tool without asking (e.g. bypassPermissions).
      const refused = await tool(run).handler(
        { repository: 'nobody/else', reason: 'r' },
        { toolUseId: 'tool-x' },
      );
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toContain('neither registered');
      const result = await tool(run).handler(
        { repository: 'acme/lib', reason: 'r' },
        { toolUseId: 'tool-add' },
      );
      expect(result.isError).toBe(false);
      expect(result.text).toContain(
        `Its clone is ${clonePath(session, 'acme', 'lib')}`,
      );
      expect(harness.approver.requests).toHaveLength(0);
      expect(added(session.id)?.addition).toMatchObject({
        by: 'claude',
        state: 'ready',
      });
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
    it('keeps an Autofix run in the chosen mode across the restart', async () => {
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
        autofixRun: true,
      });
      // Autofix runs in the session's mode like any turn.
      expect(run.switches).toEqual([]);

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
      // Neither process left auto.
      expect(run.switches).toEqual([]);
      expect(next.options.permissionMode).toBe('auto');
      expect(harness.service.get(session.id)).toMatchObject({
        permissionMode: 'auto',
        permissionModeOverride: null,
      });
      next.emit(resultMessage(15, 0.01));
      await waitFor(
        () => harness.service.get(session.id).waitingFor === 'message',
      );
      expect(next.switches).toEqual([]);
    });
  });

  describe('the tool add_branch', () => {
    const tool = (run: FakeRun) => {
      const found = run.options.tools?.find(
        (entry) => entry.name === 'add_branch',
      );
      if (!found) {
        throw new Error('no add_branch tool');
      }
      return found;
    };

    it('adds a further clone on a numbered branch without asking; push and pull requests name the branch', async () => {
      const main = await harness.addRepository('acme', 'app');
      const session = await harness.service.create({
        prompt: 'Do the work',
        repositories: [{ repositoryId: main.id }],
      });
      await harness.prepared(session.id);
      const run = harness.runner.last;

      // Never asks (the owner's decision).
      await expect(
        run.options.canUseTool(ADD_BRANCH_TOOL_NAME, { reason: 'Second fix' }, {
          signal: new AbortController().signal,
          toolUseID: 'tool-branch',
          requestId: 'r1',
          mcpServer: { name: 'crm', source: 'sdk' },
        } as never),
      ).resolves.toMatchObject({ behavior: 'allow' });
      expect(run.options.allowedTools).toContain(ADD_BRANCH_TOOL_NAME);

      const result = await tool(run).handler(
        { reason: 'Second fix' },
        { toolUseId: 'tool-branch' },
      );
      const path = `${clonePath(session, 'acme', 'app')}-2`;
      const branch = `claude/${session.slug}-2`;
      expect(result.isError).toBe(false);
      expect(result.text).toContain(
        `Its clone is ${path}, on the session branch ${branch}`,
      );
      expect(harness.approver.requests).toHaveLength(0);
      expect(run.addedDirectories).toEqual([path]);
      expect(await git(path, 'symbolic-ref', '--short', 'HEAD')).toBe(branch);
      expect(harness.service.get(session.id).directories.at(-1)).toMatchObject({
        path,
        branch,
        baseBranch: 'main',
        state: 'ready',
        addition: { by: 'claude', state: 'ready' },
      });
      expect(
        harness
          .eventsOfType(session.id, 'prepare.progress')
          .some((event) =>
            event.message?.includes(
              `Branch ${branch} requested by Claude: Second fix`,
            ),
          ),
      ).toBe(true);

      // The next one is -3.
      const third = await tool(run).handler(
        { repository: 'acme/app', reason: 'Third fix' },
        { toolUseId: 'tool-branch-3' },
      );
      expect(third.text).toContain(`claude/${session.slug}-3`);

      // Push by button: the clone is named by its branch.
      await commitFile(path, 'second.txt', 'two');
      await expect(
        harness.sessionGit.push(session.id, main.id),
      ).rejects.toThrow('name the branch');
      const pushed = await harness.sessionGit.push(session.id, main.id, branch);
      expect(await git(main.origin, 'rev-parse', `refs/heads/${branch}`)).toBe(
        pushed,
      );
      // The first clone's branch is untouched.
      await expect(
        git(main.origin, 'rev-parse', `refs/heads/claude/${session.slug}`),
      ).rejects.toThrow();
    });

    it('forgets a branch whose clone failed, so that the next one works', async () => {
      const main = await harness.addRepository('acme', 'app');
      const session = await harness.service.create({
        prompt: 'Do the work',
        repositories: [{ repositoryId: main.id }],
      });
      await harness.prepared(session.id);
      const run = harness.runner.last;
      const failed = await tool(run).handler(
        { base_branch: 'missing', reason: 'From nowhere' },
        { toolUseId: 't1' },
      );
      expect(failed.isError).toBe(true);
      expect(failed.text).toContain('No branch was added');
      expect(failed.text).toContain('Nothing was left behind');
      expect(harness.service.get(session.id).directories).toHaveLength(1);

      const next = await tool(run).handler(
        { reason: 'Second fix' },
        { toolUseId: 't2' },
      );
      expect(next.isError).toBe(false);
      expect(next.text).toContain(`claude/${session.slug}-2`);
    });

    it('resumes a restarted session with both clones', async () => {
      const main = await harness.addRepository('acme', 'app');
      const session = await harness.service.create({
        prompt: 'Do the work',
        repositories: [{ repositoryId: main.id }],
      });
      await harness.prepared(session.id);
      const run = harness.runner.last;
      await tool(run).handler({ reason: 'Second fix' }, { toolUseId: 't1' });
      run.emit(resultMessage(10, 0.01));
      await waitFor(() => harness.service.get(session.id).status === 'waiting');
      run.close();
      await flush();
      const runs = harness.runner.runs.length;
      await harness.service.send(session.id, { text: 'Go on' });
      await waitFor(() => harness.runner.runs.length > runs);
      expect(harness.runner.last.options.additionalDirectories).toContain(
        `${clonePath(session, 'acme', 'app')}-2`,
      );
    });

    it('refuses unknown repositories and a missing reason', async () => {
      const main = await harness.addRepository('acme', 'app');
      const session = await harness.service.create({
        prompt: 'Do the work',
        repositories: [{ repositoryId: main.id }],
      });
      await harness.prepared(session.id);
      const run = harness.runner.last;
      const unknown = await tool(run).handler(
        { repository: 'acme/other', reason: 'r' },
        { toolUseId: 't1' },
      );
      expect(unknown).toMatchObject({ isError: true });
      expect(unknown.text).toContain('is not a repository of this session');
      const blank = await tool(run).handler(
        { reason: ' ' },
        { toolUseId: 't2' },
      );
      expect(blank).toMatchObject({ isError: true });
      expect(blank.text).toContain('reason');
      expect(harness.service.get(session.id).directories).toHaveLength(1);
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

  describe('the tool switch_directory', () => {
    const named = (run: FakeRun, name: string) => {
      const found = run.options.tools?.find((entry) => entry.name === name);
      if (!found) {
        throw new Error(`no ${name} tool`);
      }
      return found;
    };

    it('restarts Claude Code in another clone when the turn ends, resuming the conversation, also after a server restart', async () => {
      const main = await harness.addRepository('acme', 'app');
      const session = await harness.service.create({
        prompt: 'Do the work',
        repositories: [{ repositoryId: main.id }],
      });
      await harness.prepared(session.id);
      const run = harness.runner.last;
      run.emit({ type: 'system', subtype: 'init', session_id: 'sdk-1' });
      await named(run, 'add_branch').handler(
        { reason: 'Second fix' },
        { toolUseId: 't1' },
      );
      const first = clonePath(session, 'acme', 'app');
      const second = `${first}-2`;
      const branch = `claude/${session.slug}-2`;
      const tool = named(run, 'switch_directory');

      // Never asks.
      await expect(
        run.options.canUseTool(SWITCH_DIRECTORY_TOOL_NAME, { branch }, {
          signal: new AbortController().signal,
          toolUseID: 't2',
          requestId: 'r1',
          mcpServer: { name: 'crm', source: 'sdk' },
        } as never),
      ).resolves.toMatchObject({ behavior: 'allow' });
      expect(run.options.allowedTools).toContain(SWITCH_DIRECTORY_TOOL_NAME);

      const switched = await tool.handler({ branch }, { toolUseId: 't2' });
      expect(switched.isError).toBeFalsy();
      expect(switched.text).toContain(
        `Your working directory becomes ${second}`,
      );
      const dto = harness.service.get(session.id);
      expect(dto.cwd).toBe(second);
      expect(dto.additionalDirectories).toEqual([first]);
      expect(dto.directories.map((directory) => directory.role)).toEqual([
        'additional',
        'main',
      ]);
      // Already there: nothing to do.
      expect(
        (await tool.handler({ branch }, { toolUseId: 't3' })).text,
      ).toContain('is your working directory already');
      // Unknown clones are refused.
      const unknown = await tool.handler(
        { repository: 'acme/other' },
        { toolUseId: 't4' },
      );
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain('No clone of this session matches');

      // The turn ends: the process goes; the next message starts it there.
      const runs = harness.runner.runs.length;
      run.emit(resultMessage(10, 0.01));
      await waitFor(() => harness.service.get(session.id).status === 'waiting');
      await flush();
      expect(harness.runner.runs).toHaveLength(runs);
      await harness.service.send(session.id, { text: 'Go on' });
      await waitFor(() => harness.runner.runs.length > runs);
      const next = harness.runner.last;
      expect(next.options.cwd).toBe(second);
      expect(next.options.resume).toBe('sdk-1');
      expect(next.options.additionalDirectories).toContain(first);
      expect(next.options.additionalDirectories).not.toContain(second);

      // The choice survives a restart of the server.
      next.emit(resultMessage(10, 0.01));
      await waitFor(() => harness.service.get(session.id).status === 'waiting');
      await harness.start();
      expect(harness.service.get(session.id).cwd).toBe(second);
      const before = harness.runner.runs.length;
      await harness.service.send(session.id, { text: 'Once more' });
      await waitFor(() => harness.runner.runs.length > before);
      expect(harness.runner.last.options.cwd).toBe(second);
      expect(harness.runner.last.options.resume).toBe('sdk-1');
    });

    /** A session with a second clone, its first turn still running. */
    const twoClones = async () => {
      const main = await harness.addRepository('acme', 'app');
      const session = await harness.service.create({
        prompt: 'Do the work',
        repositories: [{ repositoryId: main.id }],
      });
      await harness.prepared(session.id);
      const run = harness.runner.last;
      run.emit({ type: 'system', subtype: 'init', session_id: 'sdk-1' });
      await named(run, 'add_branch').handler(
        { reason: 'Second fix' },
        { toolUseId: 't1' },
      );
      return {
        session,
        run,
        second: `${clonePath(session, 'acme', 'app')}-2`,
        branch: `claude/${session.slug}-2`,
      };
    };

    it('closes an idle process at once', async () => {
      const { session, run, branch } = await twoClones();
      run.emit(resultMessage(10, 0.01));
      await waitFor(() => harness.service.get(session.id).status === 'waiting');
      expect(run.closed).toBe(false);
      await named(run, 'switch_directory').handler(
        { branch },
        { toolUseId: 't2' },
      );
      await waitFor(() => run.closed);
    });

    it('keeps the process for background tasks and restarts once they ended', async () => {
      const { session, run, second, branch } = await twoClones();
      // Claude may report back a moment after its tasks ended.
      harness.service.backgroundReportGraceMs = 30;
      await named(run, 'switch_directory').handler(
        { branch },
        { toolUseId: 't2' },
      );
      const tasks = (...ids: string[]) =>
        ({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: ids.map((id) => ({
            task_id: id,
            task_type: 'local_bash',
            description: id,
          })),
        }) as never;
      run.emit(tasks('server'), resultMessage(10, 0.01));
      await waitFor(
        () => harness.service.get(session.id).waitingFor === 'background',
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The dev server would end with the process.
      expect(run.closed).toBe(false);
      run.emit(tasks());
      await waitFor(() => run.closed);
      const runs = harness.runner.runs.length;
      await harness.service.send(session.id, { text: 'Go on' });
      await waitFor(() => harness.runner.runs.length > runs);
      expect(harness.runner.last.options.cwd).toBe(second);
    });

    it('does not restart again after a crash: the new process has the new directory', async () => {
      const { session, run, second, branch } = await twoClones();
      await named(run, 'switch_directory').handler(
        { branch },
        { toolUseId: 't2' },
      );
      run.crash(new Error('Claude Code process exited with code 1'));
      await waitFor(() => harness.service.get(session.id).status === 'failed');
      const runs = harness.runner.runs.length;
      await harness.service.send(session.id, { text: 'Retry' });
      await waitFor(() => harness.runner.runs.length > runs);
      const next = harness.runner.last;
      expect(next.options.cwd).toBe(second);
      next.emit(resultMessage(10, 0.01));
      await waitFor(() => harness.service.get(session.id).status === 'waiting');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(next.closed).toBe(false);
      await harness.service.send(session.id, { text: 'More' });
      await flush();
      expect(harness.runner.runs).toHaveLength(runs + 1);
      expect(next.sent.at(-1)?.text).toBe('More');
    });

    it('needs the branch when a repository has several clones', async () => {
      const main = await harness.addRepository('acme', 'app');
      const session = await harness.service.create({
        prompt: 'Do the work',
        repositories: [{ repositoryId: main.id }],
      });
      await harness.prepared(session.id);
      const run = harness.runner.last;
      await named(run, 'add_branch').handler(
        { reason: 'Second fix' },
        { toolUseId: 't1' },
      );
      const result = await named(run, 'switch_directory').handler(
        { repository: 'acme/app' },
        { toolUseId: 't2' },
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Several clones match');
      expect(harness.service.get(session.id).cwd).toBe(
        clonePath(session, 'acme', 'app'),
      );
    });
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
