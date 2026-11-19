import { execFileSync } from 'node:child_process';
import type { PullRequestDto } from '@claude-remote-manager/shared-types';
import { commitFile } from '../git/testing/git-fixtures';
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

    // Not viewed: nothing is read.
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
});
