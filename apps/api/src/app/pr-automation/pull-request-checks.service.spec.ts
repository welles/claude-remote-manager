import { execFileSync } from 'node:child_process';
import type { PullRequestDto } from '@claude-remote-manager/shared-types';
import { commitFile, git } from '../git/testing/git-fixtures';
import type { FakeRepository } from '../github/testing/fake-github';
import { resultMessage, waitFor } from '../sessions/testing/fake-agent';
import { ViewerPresence } from '../sessions/viewer-presence';
import { WorkspaceHarness } from '../workspaces/testing/workspace-harness';
import {
  checksDto,
  checkState,
  PullRequestChecksService,
  type PullRequestChecksTiming,
} from './pull-request-checks.service';
import { PullRequestFeedback, type CheckResult } from './pull-request-feedback';

const result = (patch: Partial<CheckResult>): CheckResult => ({
  kind: 'check_run',
  id: 1,
  name: 'test',
  status: 'completed',
  conclusion: 'success',
  url: null,
  app: 'github-actions',
  title: null,
  summary: null,
  ...patch,
});

describe('checkState and checksDto', () => {
  it('maps check runs and statuses to the states the view shows', () => {
    expect(checkState(result({ status: 'queued', conclusion: null }))).toBe(
      'pending',
    );
    expect(checkState(result({ status: 'in_progress' }))).toBe('pending');
    expect(checkState(result({ conclusion: 'timed_out' }))).toBe('failure');
    expect(checkState(result({ conclusion: 'action_required' }))).toBe(
      'failure',
    );
    expect(checkState(result({ conclusion: 'stale' }))).toBe('cancelled');
    expect(checkState(result({ conclusion: 'skipped' }))).toBe('skipped');
    expect(
      checkState(
        result({ kind: 'status', status: 'pending', conclusion: 'pending' }),
      ),
    ).toBe('pending');
    expect(checkState(result({ kind: 'status', conclusion: 'error' }))).toBe(
      'failure',
    );
  });

  it('sorts failed first, then running, and keeps only web links', () => {
    const dto = checksDto(
      'a'.repeat(40),
      [
        result({ name: 'build', url: 'https://github.com/runs/1' }),
        result({ name: 'lint', status: 'in_progress', conclusion: null }),
        result({ name: 'test', conclusion: 'failure', url: 'javascript:x' }),
        result({ name: 'docs', conclusion: 'skipped' }),
      ],
      new Date('2026-11-19T10:00:00Z'),
    );
    expect(dto).toEqual({
      headSha: 'a'.repeat(40),
      readAt: '2026-11-19T10:00:00.000Z',
      checks: [
        { name: 'test', state: 'failure', url: null },
        { name: 'lint', state: 'pending', url: null },
        { name: 'build', state: 'success', url: 'https://github.com/runs/1' },
        { name: 'docs', state: 'skipped', url: null },
      ],
    });
  });
});

describe('PullRequestChecksService', () => {
  let harness: WorkspaceHarness;
  let presence: ViewerPresence;
  let checks: PullRequestChecksService;
  let timing: PullRequestChecksTiming;
  let remote: FakeRepository;
  let repositoryId: string;

  beforeEach(async () => {
    harness = new WorkspaceHarness();
    await harness.start();
    const repository = await harness.addRepository('alice', 'app');
    repositoryId = repository.id;
    const installation = harness.github.addInstallation('alice');
    remote = harness.github.addRepository(installation, 'app');
    harness.repositoryRecords.update(repository.id, {
      githubRepositoryId: remote.id,
      githubInstallationId: installation.id,
    });
    harness.github.headSha = (_, head) =>
      execFileSync('git', ['rev-parse', `refs/heads/${head}`], {
        cwd: repository.origin,
      })
        .toString()
        .trim();
    presence = new ViewerPresence();
    timing = {
      pollMs: 0,
      staleMs: 60_000,
      debounceMs: 5,
      maxWaitMs: 50,
      runningWindowMs: 60_000,
      emptyWindowMs: 0,
      headRetryMs: 5,
      ciStartMs: 0,
      ciSettleMs: 60_000,
    };
    checks = new PullRequestChecksService(
      harness.sessions,
      harness.repositoryRecords,
      harness.service,
      harness.sessionGit,
      harness.github.service,
      new PullRequestFeedback(harness.github.service, harness.github.http),
      presence,
      timing,
    );
    checks.onModuleInit();
  });

  afterEach(async () => {
    checks.onModuleDestroy();
    await harness.close();
  });

  /** A session whose first turn ended, with an open pull request. */
  const sessionWithPullRequest = async (): Promise<{
    sessionId: string;
    pull: PullRequestDto;
    head: string;
  }> => {
    const created = await harness.service.create({
      prompt: 'Work',
      title: 'Improve the app',
      repositories: [{ repositoryId }],
    });
    await harness.prepared(created.id);
    harness.runner.last.emit(resultMessage(10, 0.01));
    await waitFor(
      () => harness.service.get(created.id).waitingFor === 'message',
    );
    await commitFile(harness.service.get(created.id).cwd, 'work.txt', 'w');
    const pull = await harness.sessionGit.createPullRequest(
      created.id,
      repositoryId,
      { title: 'Work' },
      'user',
    );
    const record = harness.sessions.pullRequest(pull.id);
    return {
      sessionId: created.id,
      pull,
      head: record?.headSha as string,
    };
  };

  const checksOf = (pull: PullRequestDto) =>
    harness.service
      .get(harness.sessions.pullRequest(pull.id)?.sessionId as string)
      .pullRequests.find((entry) => entry.id === pull.id)?.checks ?? null;

  const checkReads = () =>
    harness.github.requestsTo('GET', /\/check-runs$/).length;

  it('reads the checks of a new pull request and publishes them', async () => {
    const { sessionId, pull, head } = await sessionWithPullRequest();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const updates: string[] = [];
    const subscription = harness.service.updates$.subscribe((session) =>
      updates.push(session.id),
    );
    harness.github.checkRuns.set(head, [
      {
        id: 1,
        name: 'test',
        status: 'in_progress',
        conclusion: null,
        app: 'github-actions',
      },
    ]);
    harness.github.statuses.set(head, [
      { context: 'ci/legacy', state: 'success', description: 'ok' },
    ]);
    const before = harness.service.get(sessionId).updatedAt;
    await waitFor(() => checksOf(pull) !== null);
    subscription.unsubscribe();
    expect(checksOf(pull)).toMatchObject({
      headSha: head,
      checks: [
        {
          name: 'test',
          state: 'pending',
          url: `https://github.com/alice/app/runs/1`,
        },
        {
          name: 'ci/legacy',
          state: 'success',
          url: 'https://ci.example.com/build',
        },
      ],
    });
    expect(updates).toContain(sessionId);
    // CI progress does not move the session up the list.
    expect(harness.service.get(sessionId).updatedAt).toBe(before);
  });

  it('re-reads the checks of viewed sessions while they run', async () => {
    const { sessionId, pull, head } = await sessionWithPullRequest();
    const runs = [
      {
        id: 1,
        name: 'test',
        status: 'in_progress' as const,
        conclusion: null,
        app: 'github-actions',
      },
    ];
    harness.github.checkRuns.set(head, runs);
    await waitFor(() => checksOf(pull) !== null);

    // Not viewed and not waiting for its CI: nothing is read.
    harness.service.setCiWait(sessionId, pull.id, null);
    let reads = checkReads();
    await checks.poll();
    expect(checkReads()).toBe(reads);

    presence.update({}, sessionId, true);
    runs[0] = {
      ...runs[0],
      status: 'completed',
      conclusion: 'success',
    } as never;
    await checks.poll();
    expect(checkReads()).toBe(reads + 1);
    expect(checksOf(pull)?.checks[0].state).toBe('success');

    // Settled: not read again before they are stale.
    reads = checkReads();
    await checks.poll();
    expect(checkReads()).toBe(reads);
  });

  it('reads the checks of the named pull requests on a webhook delivery', async () => {
    const { pull, head } = await sessionWithPullRequest();
    await waitFor(() => checksOf(pull) !== null);
    expect(checksOf(pull)?.checks).toEqual([]);
    harness.github.checkRuns.set(head, [
      {
        id: 2,
        name: 'lint',
        status: 'completed',
        conclusion: 'failure',
        app: 'github-actions',
      },
    ]);
    checks.onDelivery(remote.id, [pull.number + 1]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(checksOf(pull)?.checks).toEqual([]);
    checks.onDelivery(remote.id, [pull.number]);
    await waitFor(() => checksOf(pull)?.checks.length === 1);
    expect(checksOf(pull)?.checks[0]).toMatchObject({
      name: 'lint',
      state: 'failure',
    });
  });

  it('stores checks the automation read only for the current head and in read order', async () => {
    const { pull, head } = await sessionWithPullRequest();
    await waitFor(() => checksOf(pull) !== null);
    const now = Date.now();
    checks.store(
      pull.id,
      'b'.repeat(40),
      [result({ name: 'old' })],
      new Date(now + 1000),
    );
    expect(checksOf(pull)?.checks).toEqual([]);
    checks.store(
      pull.id,
      head,
      [result({ name: 'new' })],
      new Date(now + 2000),
    );
    expect(checksOf(pull)?.checks).toEqual([
      { name: 'new', state: 'success', url: null },
    ]);
    // A read that started earlier but finished later is dropped.
    checks.store(
      pull.id,
      head,
      [result({ name: 'older' })],
      new Date(now + 1500),
    );
    expect(checksOf(pull)?.checks[0].name).toBe('new');
  });

  it('skips a delivery read when the automation stored newer checks meanwhile', async () => {
    const { pull, head } = await sessionWithPullRequest();
    await waitFor(() => checksOf(pull) !== null);
    const reads = checkReads();
    checks.onDelivery(remote.id);
    checks.store(
      pull.id,
      head,
      [result({ name: 'auto' })],
      new Date(Date.now() + 1000),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(checkReads()).toBe(reads);
    expect(checksOf(pull)?.checks[0].name).toBe('auto');
  });

  it('reads once for a burst of deliveries (statuses name no pull request)', async () => {
    const { pull } = await sessionWithPullRequest();
    await waitFor(() => checksOf(pull) !== null);
    const reads = checkReads();
    for (let i = 0; i < 5; i++) {
      checks.onDelivery(remote.id);
    }
    await waitFor(() => checkReads() > reads);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(checkReads()).toBe(reads + 1);
  });

  it('drops checks read for a head commit that moved meanwhile', async () => {
    const { pull, head } = await sessionWithPullRequest();
    await waitFor(() => checksOf(pull) !== null);
    harness.github.checkRuns.set(head, [
      {
        id: 3,
        name: 'test',
        status: 'completed',
        conclusion: 'success',
        app: 'github-actions',
      },
    ]);
    harness.github.intercept = (request) => {
      if (/\/check-runs$/.test(request.path)) {
        harness.sessions.updatePullRequest(pull.id, {
          headSha: 'c'.repeat(40),
        });
      }
      return undefined;
    };
    await checks.read(pull.id);
    harness.github.intercept = null;
    expect(checksOf(pull)?.checks).toEqual([]);
  });

  it('polls a viewed pull request without checks only within its window', async () => {
    const { sessionId, pull } = await sessionWithPullRequest();
    await waitFor(() => checksOf(pull) !== null);
    presence.update({}, sessionId, true);
    let reads = checkReads();
    await checks.poll();
    expect(checkReads()).toBe(reads);
    timing.emptyWindowMs = 60_000;
    reads = checkReads();
    await checks.poll();
    expect(checkReads()).toBe(reads + 1);
  });

  it('keeps polling going when a viewed session is gone', async () => {
    presence.update({}, 'missing', true);
    await expect(checks.poll()).resolves.toBeUndefined();
  });

  describe('waiting for CI', () => {
    const running = {
      id: 1,
      name: 'test',
      status: 'in_progress' as const,
      conclusion: null,
      app: 'github-actions',
    };

    it('shows a session whose checks run as waiting for them, ready once they passed', async () => {
      const { sessionId, pull, head } = await sessionWithPullRequest();
      harness.github.checkRuns.set(head, [running]);
      await waitFor(
        () => harness.service.get(sessionId).waitingFor === 'background',
      );
      expect(harness.service.get(sessionId)).toMatchObject({
        status: 'waiting',
        waitingFor: 'background',
        waitingReason: `CI of #${pull.number}`,
        backgroundTasks: 0,
      });
      // The app may send it messages (autofix) meanwhile.
      expect(harness.service.acceptsAppMessage(sessionId)).toBe(true);

      // Not viewed, but waiting for CI: polled.
      harness.github.checkRuns.set(head, [
        { ...running, status: 'completed', conclusion: 'success' } as never,
      ]);
      await checks.poll();
      expect(harness.service.get(sessionId)).toMatchObject({
        waitingFor: 'message',
        waitingReason: null,
      });
      expect(harness.service.ciWaitingSessions()).toEqual([]);
    });

    it('waits a short time for the checks of a new head commit to show up', async () => {
      timing.ciStartMs = 60_000;
      const { sessionId, pull, head } = await sessionWithPullRequest();
      await waitFor(() => checksOf(pull) !== null);
      expect(harness.service.get(sessionId).waitingFor).toBe('background');
      // Checks show up: the wait goes on while they run.
      harness.github.checkRuns.set(head, [running]);
      await checks.read(pull.id);
      expect(harness.service.ciWaitPhase(sessionId, pull.id)).toBe('running');

      // Without any checks the wait ends by itself.
      timing.ciStartMs = 30;
      harness.github.checkRuns.set(head, []);
      harness.sessions.updatePullRequest(pull.id, { headSha: 'd'.repeat(40) });
      await checks.read(pull.id);
      expect(harness.service.get(sessionId).waitingFor).toBe('background');
      await waitFor(
        () => harness.service.get(sessionId).waitingFor === 'message',
      );
    });

    it('does not wait for settled checks read again, nor for a pull request without CI', async () => {
      const { sessionId, pull, head } = await sessionWithPullRequest();
      await waitFor(() => checksOf(pull) !== null);
      expect(harness.service.get(sessionId).waitingFor).toBe('message');
      harness.github.checkRuns.set(head, [
        { ...running, status: 'completed', conclusion: 'success' } as never,
      ]);
      harness.sessions.updatePullRequest(pull.id, { autofix: true });
      await checks.read(pull.id);
      expect(harness.service.get(sessionId).waitingFor).toBe('message');
    });

    it('keeps waiting for settled checks with autofix until the automation looked', async () => {
      const { sessionId, pull, head } = await sessionWithPullRequest();
      harness.sessions.updatePullRequest(pull.id, { autofix: true });
      const settled: number[] = [];
      const subscription = checks.settled$.subscribe((id) => settled.push(id));
      harness.github.checkRuns.set(head, [running]);
      await waitFor(() => checksOf(pull)?.checks.length === 1);
      expect(harness.service.ciWaitPhase(sessionId, pull.id)).toBe('running');

      harness.github.checkRuns.set(head, [
        { ...running, status: 'completed', conclusion: 'failure' } as never,
      ]);
      await checks.read(pull.id);
      expect(settled).toEqual([pull.id]);
      expect(harness.service.ciWaitPhase(sessionId, pull.id)).toBe('settling');
      expect(harness.service.get(sessionId).waitingFor).toBe('background');
      // Read again meanwhile: still waiting, not announced again.
      await checks.read(pull.id);
      expect(settled).toEqual([pull.id]);
      expect(harness.service.ciWaitPhase(sessionId, pull.id)).toBe('settling');

      harness.service.endCiSettling(sessionId, pull.id);
      expect(harness.service.get(sessionId).waitingFor).toBe('message');
      subscription.unsubscribe();
    });

    it('ends the settling wait by itself when the automation never looks', async () => {
      timing.ciSettleMs = 30;
      const { sessionId, pull, head } = await sessionWithPullRequest();
      harness.sessions.updatePullRequest(pull.id, { autofix: true });
      harness.github.checkRuns.set(head, [running]);
      await waitFor(() => checksOf(pull)?.checks.length === 1);
      harness.github.checkRuns.set(head, [
        { ...running, status: 'completed', conclusion: 'success' } as never,
      ]);
      await checks.read(pull.id);
      expect(harness.service.ciWaitPhase(sessionId, pull.id)).toBe('settling');
      await waitFor(
        () => harness.service.get(sessionId).waitingFor === 'message',
      );
    });

    it('stops waiting when the pull request is closed', async () => {
      const { sessionId, pull, head } = await sessionWithPullRequest();
      harness.github.checkRuns.set(head, [running]);
      await waitFor(
        () => harness.service.get(sessionId).waitingFor === 'background',
      );
      const states: string[] = [];
      const subscription = harness.service.updates$.subscribe((session) => {
        if (session.id === sessionId) {
          states.push(`${session.status}/${session.waitingFor ?? ''}`);
        }
      });
      const fake = harness.github.pulls.find(
        (entry) => entry.number === pull.number,
      );
      if (!fake) {
        throw new Error('pull request missing');
      }
      fake.state = 'closed';
      fake.merged = true;
      await harness.sessionGit.refreshPullRequest(pull.id);
      subscription.unsubscribe();
      expect(harness.service.get(sessionId).waitingFor).toBe('message');
      expect(states.at(-1)).toBe('waiting/message');
      expect(harness.service.ciWaitPhase(sessionId, pull.id)).toBeNull();
      expect(harness.service.ciWaitingSessions()).toEqual([]);
      // The status event is in the session's history too.
      expect(
        harness.eventsOfType(sessionId, 'session.status').at(-1),
      ).toMatchObject({ waitingFor: 'message' });
    });

    it('waits right after a push to the branch of an open pull request, until its new checks are read', async () => {
      timing.ciStartMs = 60_000;
      const { sessionId, pull, head } = await sessionWithPullRequest();
      await waitFor(() => checksOf(pull) !== null);
      harness.github.checkRuns.set(head, [
        { ...running, status: 'completed', conclusion: 'success' } as never,
      ]);
      await checks.read(pull.id);
      expect(harness.service.get(sessionId).waitingFor).toBe('message');

      const clone = harness.service.get(sessionId).cwd;
      await commitFile(clone, 'more.txt', 'm');
      await git(clone, 'push', 'origin', 'HEAD');
      const fake = harness.github.pulls.find(
        (entry) => entry.number === pull.number,
      );
      if (!fake) {
        throw new Error('pull request missing');
      }
      // GitHub shows the new head only on the second read.
      const pushed = (await git(clone, 'rev-parse', 'HEAD')).trim();
      harness.github.checkRuns.set(pushed, [running]);
      let reads = 0;
      harness.github.intercept = (request) => {
        if (request.method === 'GET' && /\/pulls\/\d+$/.test(request.path)) {
          reads += 1;
          fake.headSha = reads >= 2 ? pushed : head;
        }
        return undefined;
      };
      expect(
        await harness.sessionGit.notePushedCommit(sessionId, repositoryId),
      ).toBe(true);
      expect(harness.service.get(sessionId)).toMatchObject({
        waitingFor: 'background',
        waitingReason: `CI of #${pull.number}`,
      });
      await waitFor(() => checksOf(pull)?.headSha === pushed);
      harness.github.intercept = null;
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(harness.service.get(sessionId).waitingFor).toBe('background');
      expect(harness.service.ciWaitPhase(sessionId, pull.id)).toBe('running');
    });

    it('reads checks that ran before a restart again', async () => {
      const { sessionId, pull, head } = await sessionWithPullRequest();
      harness.github.checkRuns.set(head, [running]);
      await waitFor(() => checksOf(pull)?.checks.length === 1);
      harness.service.setCiWait(sessionId, pull.id, null);
      checks.onModuleDestroy();
      checks = new PullRequestChecksService(
        harness.sessions,
        harness.repositoryRecords,
        harness.service,
        harness.sessionGit,
        harness.github.service,
        new PullRequestFeedback(harness.github.service, harness.github.http),
        presence,
        timing,
      );
      checks.onModuleInit();
      await waitFor(
        () => harness.service.get(sessionId).waitingFor === 'background',
      );
    });
  });
});
