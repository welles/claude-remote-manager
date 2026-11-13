import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type {
  PullRequestDto,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { DevServers } from '../dev-servers/dev-servers';
import { commitFile, git } from '../git/testing/git-fixtures';
import type {
  FakeRepository,
  FakeReviewItem,
} from '../github/testing/fake-github';
import type { NotificationsService } from '../notifications/notifications.service';
import { SessionEventRepository } from '../sessions/session-event.repository';
import { resultMessage, waitFor } from '../sessions/testing/fake-agent';
import { WorkspaceHarness } from '../workspaces/testing/workspace-harness';
import { PrAutomationService } from './pr-automation.service';
import { PullRequestFeedback } from './pull-request-feedback';

/** Notifications the automation sent. */
class RecordingNotifications {
  readonly gaveUp: {
    sessionId: string;
    pull: PullRequestDto;
    attempts: number;
  }[] = [];
  readonly closed: {
    sessionId: string;
    pull: PullRequestDto;
    note: string | null;
  }[] = [];
  notifyAutofixGaveUp(
    sessionId: string,
    pull: PullRequestDto,
    attempts: number,
  ) {
    this.gaveUp.push({ sessionId, pull, attempts });
    return true;
  }
  notifyPullRequestClosed(
    sessionId: string,
    pull: PullRequestDto,
    note: string | null = null,
  ) {
    this.closed.push({ sessionId, pull, note });
    return true;
  }
}

class RecordingDevServers extends DevServers {
  readonly stopped: string[] = [];
  async stopSession(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
  }
}

const sha = (char: string) => char.repeat(40);

describe('PrAutomationService', () => {
  let harness: WorkspaceHarness;
  let automation: PrAutomationService;
  let notifications: RecordingNotifications;
  let devServers: RecordingDevServers;
  let remote: FakeRepository;
  let origin: string;
  let repositoryId: string;

  const createAutomation = () => {
    automation = new PrAutomationService(
      harness.config,
      {
        pollMs: 0,
        debounceMs: 5,
        idleRecheckMs: 5,
        ciSettleMs: 60_000,
        ciRecheckMs: 60_000,
      },
      harness.sessions,
      harness.repositoryRecords,
      harness.service,
      harness.sessionGit,
      harness.git,
      harness.github.service,
      new PullRequestFeedback(harness.github.service, harness.github.http),
      notifications as unknown as NotificationsService,
      harness.hooks,
      devServers,
    );
    automation.onModuleInit();
  };

  beforeEach(async () => {
    harness = new WorkspaceHarness();
    await harness.start();
    notifications = new RecordingNotifications();
    devServers = new RecordingDevServers();
    const repository = await harness.addRepository('alice', 'app');
    origin = repository.origin;
    repositoryId = repository.id;
    const installation = harness.github.addInstallation('alice');
    remote = harness.github.addRepository(installation, 'app');
    harness.repositoryRecords.update(repository.id, {
      githubRepositoryId: remote.id,
      githubInstallationId: installation.id,
    });
    harness.github.headSha = (_, head) =>
      execFileSync('git', ['rev-parse', `refs/heads/${head}`], {
        cwd: origin,
      })
        .toString()
        .trim();
    harness.github.collaborators.set('owner', 'admin');
    harness.github.collaborators.set('maintainer', 'maintain');
    harness.github.collaborators.set('reader', 'read');
    createAutomation();
  });

  afterEach(async () => {
    automation.onModuleDestroy();
    await harness.close();
  });

  /** A session whose first turn ended, with an open pull request. */
  const sessionWithPullRequest = async (): Promise<{
    session: SessionDto;
    pull: PullRequestDto;
    clone: string;
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
    const session = harness.service.get(created.id);
    const clone = session.cwd;
    await commitFile(clone, 'work.txt', 'w');
    const pull = await harness.sessionGit.createPullRequest(
      session.id,
      repositoryId,
      { title: 'Work' },
      'user',
    );
    return { session: harness.service.get(session.id), pull, clone };
  };

  const fakePull = (number: number) =>
    harness.github.pulls.find(
      (pull) => pull.repositoryId === remote.id && pull.number === number,
    ) as (typeof harness.github.pulls)[number];

  const enableAutofix = (sessionId: string, pull: PullRequestDto) =>
    automation.update(sessionId, pull.id, { autofix: true });

  const record = (pull: PullRequestDto) =>
    harness.sessions.pullRequest(pull.id) as NonNullable<
      ReturnType<typeof harness.sessions.pullRequest>
    >;

  /** Messages the app sent to Claude after the first one. */
  const appMessages = () =>
    harness.runner.runs.flatMap((run) =>
      run.sent.filter((message) => message.text.startsWith('Autofix')),
    );

  const later = (seconds = 5) =>
    new Date(Date.now() + seconds * 1000).toISOString();

  const addReview = (pull: PullRequestDto, item: Partial<FakeReviewItem>) => {
    const key = `${remote.id}#${pull.number}`;
    const items = harness.github.reviewItems.get(key) ?? [];
    items.push({
      kind: 'review_comment',
      id: items.length + 1,
      author: 'owner',
      body: 'Please rename this variable.',
      createdAt: later(),
      path: 'src/app.ts',
      line: 12,
      diffHunk: '@@ -10,3 +10,3 @@\n-const a = 1;\n+const b = 1;',
      ...item,
    });
    harness.github.reviewItems.set(key, items);
  };

  describe('autofix for failed checks', () => {
    it('starts one run with all failed checks of the head commit and their logs', async () => {
      const { session, pull } = await sessionWithPullRequest();
      const head = fakePull(pull.number).headSha;
      harness.github.checkRuns.set(head, [
        {
          id: 11,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          app: 'github-actions',
          title: 'Tests failed',
        },
        {
          id: 12,
          name: 'lint',
          status: 'completed',
          conclusion: 'failure',
          app: 'github-actions',
        },
        {
          id: 13,
          name: 'build',
          status: 'completed',
          conclusion: 'success',
          app: 'github-actions',
        },
      ]);
      harness.github.statuses.set(head, [
        { context: 'ci/legacy', state: 'error', description: 'Build errored' },
      ]);
      harness.github.jobLogs.set(
        11,
        '2026-11-13T10:00:00.0000000Z \u001b[31mstarting\u001b[0m\n2026-11-13T10:00:01.0000000Z ##[error]expected 2 to be 3\n',
      );
      enableAutofix(session.id, pull);

      await automation.check(pull.id);

      const messages = appMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toContain('attempt 1 of 3');
      expect(messages[0].text).toContain('alice/app#1');
      expect(messages[0].text).not.toContain('@');
      const context = messages[0].context?.text ?? '';
      expect(context).toContain('name="test"');
      expect(context).toContain('name="lint"');
      expect(context).toContain('name="ci/legacy"');
      expect(context).not.toContain('name="build"');
      expect(context).toContain('##[error]expected 2 to be 3');
      expect(context).not.toContain('\u001b[31m');
      expect(context).not.toContain('2026-11-13T10:00:01');
      // The app's message is shown as such in the history.
      const user = harness
        .eventsOfType(session.id, 'user.message')
        .find((event) => event.text.startsWith('Autofix'));
      expect(user?.origin).toBe('app');
      expect(record(pull)).toMatchObject({
        autofixAttempts: 1,
        autofixLastTrigger: 'ci',
        autofixRunning: true,
        autofixCiHandledSha: head,
      });
      expect(
        harness.service.get(session.id).pullRequests[0].automation,
      ).toMatchObject({
        attempts: 1,
        maxAttempts: 3,
        running: true,
        lastTrigger: 'ci',
      });

      // The turn ends: the run is over; the same commit starts no second run.
      harness.runner.last.emit(resultMessage(20, 0.02));
      await waitFor(() => !record(pull).autofixRunning);
      await automation.check(pull.id);
      expect(appMessages()).toHaveLength(1);
    });

    it('ignores failures of an older commit (stale) and checks that still run', async () => {
      const { session, pull } = await sessionWithPullRequest();
      const head = fakePull(pull.number).headSha;
      harness.github.checkRuns.set(sha('b'), [
        {
          id: 21,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          app: 'github-actions',
        },
      ]);
      harness.github.checkRuns.set(head, [
        {
          id: 22,
          name: 'test',
          status: 'in_progress',
          conclusion: null,
          app: 'github-actions',
        },
      ]);
      enableAutofix(session.id, pull);

      await automation.check(pull.id);

      expect(appMessages()).toHaveLength(0);
      expect(record(pull).autofixAttempts).toBe(0);
    });

    it('waits for the other checks of the commit before starting the run', async () => {
      const { session, pull } = await sessionWithPullRequest();
      const head = fakePull(pull.number).headSha;
      const runs = [
        {
          id: 31,
          name: 'lint',
          status: 'completed' as const,
          conclusion: 'failure',
          app: 'github-actions',
        },
        {
          id: 32,
          name: 'test',
          status: 'in_progress' as const,
          conclusion: null as string | null,
          app: 'github-actions',
        },
      ];
      harness.github.checkRuns.set(head, runs);
      enableAutofix(session.id, pull);

      await automation.check(pull.id);
      expect(appMessages()).toHaveLength(0);

      runs[1] = { ...runs[1], status: 'completed', conclusion: 'failure' };
      await automation.check(pull.id);
      expect(appMessages()).toHaveLength(1);
      const context = appMessages()[0].context?.text ?? '';
      expect(context).toContain('name="lint"');
      expect(context).toContain('name="test"');
    });

    it('waits while the session is busy and runs when it waits for a message again', async () => {
      const { session, pull } = await sessionWithPullRequest();
      const head = fakePull(pull.number).headSha;
      harness.github.checkRuns.set(head, [
        {
          id: 41,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          app: 'github-actions',
        },
      ]);
      enableAutofix(session.id, pull);
      // The owner sends a message: a turn runs.
      await harness.service.sendMessage(session.id, { text: 'Also add docs' });
      expect(harness.service.get(session.id).status).toBe('running');

      await automation.check(pull.id);
      expect(appMessages()).toHaveLength(0);

      harness.runner.last.emit(resultMessage(30, 0.03));
      await waitFor(() => appMessages().length === 1);
      expect(record(pull).autofixAttempts).toBe(1);
    });

    it('stops after the attempt limit, notifies once, and continues after a reset', async () => {
      const { session, pull } = await sessionWithPullRequest();
      automation.update(session.id, pull.id, { autofix: true, maxAttempts: 1 });
      const failing = (commit: string, id: number) =>
        harness.github.checkRuns.set(commit, [
          {
            id,
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            app: 'ci',
          },
        ]);
      failing(fakePull(pull.number).headSha, 51);
      await automation.check(pull.id);
      expect(appMessages()).toHaveLength(1);
      harness.runner.last.emit(resultMessage(40, 0.04));
      await waitFor(() => !record(pull).autofixRunning);

      // Claude pushed a new commit; its checks fail again.
      fakePull(pull.number).headSha = sha('c');
      failing(sha('c'), 52);
      await automation.check(pull.id);
      await automation.check(pull.id);

      expect(appMessages()).toHaveLength(1);
      expect(notifications.gaveUp).toHaveLength(1);
      expect(notifications.gaveUp[0].attempts).toBe(1);
      expect(
        harness.service.get(session.id).pullRequests[0].automation.gaveUp,
      ).toBe(true);
      expect(
        harness
          .eventsOfType(session.id, 'notice')
          .some((event) => event.text.includes('reached its limit')),
      ).toBe(true);

      automation.update(session.id, pull.id, { resetAttempts: true });
      expect(
        harness.service.get(session.id).pullRequests[0].automation,
      ).toMatchObject({
        attempts: 0,
        gaveUp: false,
      });
      await waitFor(() => appMessages().length === 2);
    });

    it('keeps the attempt count across restarts', async () => {
      const { session, pull } = await sessionWithPullRequest();
      harness.github.checkRuns.set(fakePull(pull.number).headSha, [
        {
          id: 61,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          app: 'ci',
        },
      ]);
      enableAutofix(session.id, pull);
      await automation.check(pull.id);
      expect(record(pull).autofixAttempts).toBe(1);

      automation.onModuleDestroy();
      createAutomation();

      expect(record(pull)).toMatchObject({
        autofixAttempts: 1,
        autofixRunning: false,
      });
    });
  });

  describe('autofix for reviews', () => {
    it('starts one run for new review feedback of people with write access', async () => {
      const { session, pull } = await sessionWithPullRequest();
      // Before autofix was turned on: not new.
      addReview(pull, {
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        body: 'Old remark',
      });
      enableAutofix(session.id, pull);
      for (let i = 0; i < 10; i++) {
        addReview(pull, { body: `Remark ${i}`, line: i + 1 });
      }
      addReview(pull, {
        kind: 'review',
        body: 'Needs work',
        state: 'CHANGES_REQUESTED',
        author: 'maintainer',
      });
      addReview(pull, {
        body: 'From someone without write access',
        author: 'reader',
      });
      addReview(pull, { body: 'From a stranger', author: 'stranger' });
      addReview(pull, {
        body: 'From a bot',
        author: 'helper[bot]',
        authorType: 'Bot',
      });
      addReview(pull, { kind: 'review', body: '', state: 'APPROVED' });

      await automation.check(pull.id);

      const messages = appMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toContain('reviews or comments');
      const context = messages[0].context?.text ?? '';
      for (let i = 0; i < 10; i++) {
        expect(context).toContain(`Remark ${i}`);
      }
      expect(context).toContain('path="src/app.ts"');
      expect(context).toContain('Needs work');
      expect(context).not.toContain('Old remark');
      expect(context).not.toContain('without write access');
      expect(context).not.toContain('stranger');
      expect(context).not.toContain('From a bot');
      expect(record(pull).autofixLastTrigger).toBe('review');

      // The same feedback does not start another run.
      harness.runner.last.emit(resultMessage(50, 0.05));
      await waitFor(() => !record(pull).autofixRunning);
      await automation.check(pull.id);
      expect(appMessages()).toHaveLength(1);
    });

    it('counts comments in the pull request conversation like review comments', async () => {
      const { session, pull } = await sessionWithPullRequest();
      addReview(pull, {
        kind: 'comment',
        body: 'Old conversation comment',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      });
      enableAutofix(session.id, pull);
      addReview(pull, { kind: 'comment', body: 'Please also update the docs' });
      addReview(pull, { kind: 'comment', body: 'Do it', author: 'reader' });
      addReview(pull, {
        kind: 'comment',
        body: 'Bot says',
        author: 'helper[bot]',
        authorType: 'Bot',
      });

      await automation.check(pull.id);

      const context = appMessages()[0]?.context?.text ?? '';
      expect(context).toContain('kind="comment"');
      expect(context).toContain('Please also update the docs');
      expect(context).not.toContain('Old conversation comment');
      expect(context).not.toContain('Do it');
      expect(context).not.toContain('Bot says');
    });

    it('starts no run for feedback only from people without write access', async () => {
      const { session, pull } = await sessionWithPullRequest();
      enableAutofix(session.id, pull);
      addReview(pull, { author: 'reader' });
      addReview(pull, { author: 'stranger' });

      await automation.check(pull.id);

      expect(appMessages()).toHaveLength(0);
      expect(record(pull).autofixAttempts).toBe(0);
    });

    it('does nothing with autofix off', async () => {
      const { pull } = await sessionWithPullRequest();
      addReview(pull, {});
      harness.github.checkRuns.set(fakePull(pull.number).headSha, [
        {
          id: 71,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          app: 'ci',
        },
      ]);

      await automation.check(pull.id);

      expect(appMessages()).toHaveLength(0);
    });
  });

  describe('git during autofix', () => {
    const ask = (command: string) =>
      harness.runner.last.options.canUseTool(
        'Bash',
        { command, description: 'Commit and push' },
        {
          signal: new AbortController().signal,
          toolUseID: 'tool-git',
          requestId: 'r1',
        },
      ) as Promise<PermissionResult>;

    /** What the replaced command prints, and whether it fails. */
    const report = (result: PermissionResult) => {
      expect(result.behavior).toBe('allow');
      const command = String(
        (result as unknown as { updatedInput: { command: string } })
          .updatedInput.command,
      );
      const match =
        /^printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d(; false)?$/.exec(
          command,
        );
      expect(match).not.toBeNull();
      return {
        text: Buffer.from(match?.[1] ?? '', 'base64').toString('utf8'),
        fails: match?.[2] !== undefined,
      };
    };

    const byApp = (sessionId: string) =>
      harness.eventsOfType(sessionId, 'tool.by_app');

    it('pushes exactly the session branch itself, without asking', async () => {
      const { session, pull, clone } = await sessionWithPullRequest();
      enableAutofix(session.id, pull);
      const commit = await commitFile(clone, 'fix.txt', 'fixed');
      harness.approver.requests.length = 0;

      const output = report(await ask('git push'));

      expect(output.fails).toBe(false);
      expect(output.text).toContain(`Pushed claude/${session.slug}`);
      expect(harness.approver.requests).toHaveLength(0);
      expect(
        await git(origin, 'rev-parse', `refs/heads/claude/${session.slug}`),
      ).toBe(commit);
      expect(byApp(session.id)).toEqual([
        expect.objectContaining({
          toolUseId: 'tool-git',
          outcome: 'succeeded',
          summary: expect.stringContaining(`pushed claude/${session.slug}`),
        }),
      ]);
      // Stored, so reloads and restarts show it.
      expect(
        new SessionEventRepository(harness.db)
          .list(session.id)
          .some((stored) => stored.event.type === 'tool.by_app'),
      ).toBe(true);
    });

    it('stages, commits and pushes in one command, with hooks off', async () => {
      const { session, pull, clone } = await sessionWithPullRequest();
      enableAutofix(session.id, pull);
      // A hook in the clone must not run without approval.
      await writeFile(
        join(clone, '.git', 'hooks', 'pre-commit'),
        '#!/bin/sh\ntouch hook-ran\nexit 1\n',
        { mode: 0o755 },
      );
      await writeFile(join(clone, 'value.txt'), 'expected\n');

      const output = report(
        await ask(
          `cd ${clone} && git add value.txt && git commit -q -m "Fix the value

Co-Authored-By: Claude <noreply@anthropic.com>" && git push origin HEAD`,
        ),
      );

      expect(output.fails).toBe(false);
      expect(output.text).toContain('Done by the app');
      expect(harness.approver.requests).toHaveLength(0);
      expect(existsSync(join(clone, 'hook-ran'))).toBe(false);
      const head = await git(clone, 'rev-parse', 'HEAD');
      expect(await git(clone, 'log', '-1', '--format=%s')).toBe(
        'Fix the value',
      );
      expect(
        await git(origin, 'rev-parse', `refs/heads/claude/${session.slug}`),
      ).toBe(head);
      expect(byApp(session.id)[0]).toMatchObject({
        outcome: 'succeeded',
        summary: expect.stringMatching(/^Staged; Committed; pushed /),
      });
    });

    it('reports a failed step as failure and does not push', async () => {
      const { session, pull, clone } = await sessionWithPullRequest();
      enableAutofix(session.id, pull);
      const before = await git(
        origin,
        'rev-parse',
        `refs/heads/claude/${session.slug}`,
      );

      // Nothing to commit: git commit fails.
      const output = report(
        await ask('git add -A && git commit -m "Nothing" && git push'),
      );

      expect(output.fails).toBe(true);
      expect(output.text).toContain('Failed');
      expect(output.text).toContain(
        'Not pushed, because a step before failed.',
      );
      expect(
        await git(origin, 'rev-parse', `refs/heads/claude/${session.slug}`),
      ).toBe(before);
      expect(byApp(session.id)[0]).toMatchObject({
        outcome: 'failed',
        summary: 'Staged; git commit failed',
      });
      void clone;
    });

    it('commits but leaves a push of workflow changes to the user', async () => {
      const { session, pull, clone } = await sessionWithPullRequest();
      enableAutofix(session.id, pull);
      await mkdir(join(clone, '.github', 'workflows'), { recursive: true });
      await writeFile(
        join(clone, '.github', 'workflows', 'ci.yml'),
        'on: push\n',
      );

      const output = report(
        await ask('git add -A && git commit -m "CI" && git push'),
      );

      expect(output.fails).toBe(true);
      expect(output.text).toContain('.github/workflows');
      expect(await git(clone, 'log', '-1', '--format=%s')).toBe('CI');
      // The push alone then asks.
      void ask('git push');
      await waitFor(() => harness.approver.requests.length === 1);
    });

    it('allows amending a commit that is not pushed, and asks for a pushed one', async () => {
      const { session, pull, clone } = await sessionWithPullRequest();
      enableAutofix(session.id, pull);
      // The PR's head is pushed: amending it would need a force push.
      void ask('git commit --amend --no-edit');
      await waitFor(() => harness.approver.requests.length === 1);

      await commitFile(clone, 'local.txt', 'local');
      await writeFile(join(clone, 'local.txt'), 'changed');
      const output = report(
        await ask('git commit -a --amend -m "Local, amended"'),
      );
      expect(output.fails).toBe(false);
      expect(await git(clone, 'log', '-1', '--format=%s')).toBe(
        'Local, amended',
      );
    });

    it('asks when the clone configuration could run programs', async () => {
      const { session, pull, clone } = await sessionWithPullRequest();
      enableAutofix(session.id, pull);
      await git(clone, 'config', 'filter.x.clean', 'touch filter-ran');
      await writeFile(join(clone, 'a.txt'), 'a');

      void ask('git add a.txt');

      await waitFor(() => harness.approver.requests.length === 1);
      expect(existsSync(join(clone, 'filter-ran'))).toBe(false);
    });

    it.each([
      ['a force push', 'git push --force'],
      ['another branch', 'git push origin HEAD:main'],
      ['a deletion', 'git push origin --delete old'],
      ['tags', 'git push --tags'],
      ['another remote', 'git push upstream'],
      ['another command chained in', 'git add . && npm test && git push'],
      ['a push that is not last', 'git push && git commit -m x'],
      ['a pipe', 'git push 2>&1 | tail'],
      ['a semicolon', 'git add . ; git push'],
      ['a command substitution', 'git commit -m "$(cat msg)"'],
      ['a here-document', "git commit -F - <<'EOF'\nx\nEOF"],
      ['a config override', 'git -c core.hooksPath=x push'],
      ['commit without message', 'git commit'],
      ['commit with a file message', 'git commit -F msg.txt'],
      ['commit with an author', 'git commit -m x --author="A <a@b>"'],
      ['add outside the clone', 'git add ../other'],
      ['add with pathspec magic', "git add ':(glob)*'"],
      ['forced add', 'git add -f build'],
      ['another git command', 'git reset --hard'],
      ['a subshell', '(git add . && git commit -m x)'],
    ])('asks the user for %s', async (_, command) => {
      const { session, pull, clone } = await sessionWithPullRequest();
      enableAutofix(session.id, pull);
      await commitFile(clone, 'fix.txt', 'fixed');

      void ask(command);

      await waitFor(() => harness.approver.requests.length > 0);
      expect(harness.service.pendingPermissions(session.id)).toHaveLength(1);
      expect(byApp(session.id)).toHaveLength(0);
    });

    it('asks the user when autofix is off', async () => {
      const { clone } = await sessionWithPullRequest();
      await commitFile(clone, 'fix.txt', 'fixed');
      void ask('git add -A && git commit -m x && git push');
      await waitFor(() => harness.approver.requests.length === 1);
    });
  });

  describe('autoclose', () => {
    const merge = (number: number) => {
      const fake = fakePull(number);
      fake.state = 'closed';
      fake.merged = true;
    };

    it('ends the session and removes clean clones when the pull request is merged', async () => {
      const { session, pull, clone } = await sessionWithPullRequest();
      automation.update(session.id, pull.id, { autoclose: true });
      merge(pull.number);

      await automation.check(pull.id);
      await waitFor(() => notifications.closed.length === 1);

      const after = harness.service.get(session.id);
      expect(after.status).toBe('finished');
      expect(after.autoclosedAt).not.toBeNull();
      expect(after.directories[0].state).toBe('removed');
      expect(existsSync(clone)).toBe(false);
      expect(
        existsSync(join(harness.config.sessionsDir, session.slug as string)),
      ).toBe(false);
      expect(devServers.stopped).toEqual([session.id]);
      expect(notifications.closed[0].pull.state).toBe('merged');
      expect(notifications.closed[0].note).toContain('removed');
    });

    it('keeps a clone with work that is not on GitHub and deletes it after confirmation', async () => {
      const { session, pull, clone } = await sessionWithPullRequest();
      automation.update(session.id, pull.id, { autoclose: true });
      await writeFile(join(clone, 'notes.txt'), 'unsaved');
      await commitFile(clone, 'local.txt', 'not pushed');
      merge(pull.number);

      await automation.check(pull.id);
      await waitFor(() => notifications.closed.length === 1);

      const after = harness.service.get(session.id);
      expect(after.status).toBe('finished');
      expect(after.directories[0].state).toBe('ready');
      expect(existsSync(clone)).toBe(true);
      expect(notifications.closed[0].note).toContain('kept');
      const notice = new SessionEventRepository(harness.db)
        .list(session.id)
        .map((stored) => stored.event)
        .find(
          (event) =>
            event.type === 'notice' && event.text.includes('Autoclose'),
        ) as { text: string } | undefined;
      expect(notice?.text).toContain(
        '1 uncommitted file(s), 1 unpushed commit(s)',
      );

      const loss = await automation.cloneLoss(session.id, repositoryId);
      expect(loss).toMatchObject({
        uncommittedFiles: ['notes.txt'],
        uncommittedCount: 1,
        unpushedCount: 1,
        stashes: 0,
        clean: false,
      });
      expect(loss.unpushedCommits[0].subject).toContain('local.txt');

      await expect(
        automation.discardClone(session.id, repositoryId, {}),
      ).rejects.toThrow('confirm');
      await automation.discardClone(session.id, repositoryId, {
        confirm: true,
      });
      expect(existsSync(clone)).toBe(false);
      expect(harness.service.get(session.id).directories[0].state).toBe(
        'removed',
      );
    });

    it('waits for the other open pull requests of the session', async () => {
      const second = await harness.addRepository('alice', 'lib');
      const installation = harness.github.installations[0];
      const remoteLib = harness.github.addRepository(installation, 'lib');
      harness.repositoryRecords.update(second.id, {
        githubRepositoryId: remoteLib.id,
        githubInstallationId: installation.id,
      });
      harness.github.headSha = (repository, head) =>
        execFileSync('git', ['rev-parse', `refs/heads/${head}`], {
          cwd: repository.id === remote.id ? origin : second.origin,
        })
          .toString()
          .trim();
      const created = await harness.service.create({
        prompt: 'Work',
        repositories: [{ repositoryId }, { repositoryId: second.id }],
      });
      await harness.prepared(created.id);
      harness.runner.last.emit(resultMessage(10, 0.01));
      await waitFor(
        () => harness.service.get(created.id).waitingFor === 'message',
      );
      const session = harness.service.get(created.id);
      await commitFile(session.directories[0].path, 'a.txt', 'a');
      await commitFile(session.directories[1].path, 'b.txt', 'b');
      const app = await harness.sessionGit.createPullRequest(
        session.id,
        repositoryId,
        { title: 'A' },
        'user',
      );
      const lib = await harness.sessionGit.createPullRequest(
        session.id,
        second.id,
        { title: 'B' },
        'user',
      );
      automation.update(session.id, app.id, { autoclose: true });
      automation.update(session.id, lib.id, { autoclose: true });

      merge(app.number);
      await automation.check(app.id);
      await waitFor(() => notifications.closed.length === 1);
      expect(harness.service.get(session.id).status).not.toBe('finished');

      const libPull = harness.github.pulls.find(
        (entry) => entry.repositoryId === remoteLib.id,
      );
      if (libPull) {
        libPull.state = 'closed';
      }
      await automation.check(lib.id);
      await waitFor(() => notifications.closed.length === 2);
      expect(harness.service.get(session.id).status).toBe('finished');
      expect(notifications.closed[1].pull.state).toBe('closed');
    });

    it('only notifies without autoclose', async () => {
      const { session, pull, clone } = await sessionWithPullRequest();
      enableAutofix(session.id, pull);
      merge(pull.number);

      await automation.check(pull.id);
      await waitFor(() => notifications.closed.length === 1);
      await automation.check(pull.id);

      expect(notifications.closed).toHaveLength(1);
      expect(harness.service.get(session.id).status).not.toBe('finished');
      expect(existsSync(clone)).toBe(true);
    });
  });

  describe('polling', () => {
    it('checks open pull requests with automation, also after an empty poll', async () => {
      // Nothing to check yet: must not keep later polls from running.
      await automation.poll();
      const { session, pull } = await sessionWithPullRequest();
      harness.github.checkRuns.set(fakePull(pull.number).headSha, [
        {
          id: 91,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          app: 'ci',
        },
      ]);
      harness.sessions.updatePullRequest(pull.id, {
        autofix: true,
        autofixReviewsAfter: new Date(),
      });
      void session;

      await automation.poll();

      expect(appMessages()).toHaveLength(1);
    });
  });

  describe('webhook deliveries', () => {
    it('checks the pull requests a delivery names', async () => {
      const { session, pull } = await sessionWithPullRequest();
      harness.github.checkRuns.set(fakePull(pull.number).headSha, [
        {
          id: 81,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          app: 'ci',
        },
      ]);
      enableAutofix(session.id, pull);
      await waitFor(() => appMessages().length === 1);
      harness.runner.last.emit(resultMessage(60, 0.06));
      await waitFor(() => !record(pull).autofixRunning);
      const requests = harness.github.requests.length;

      // Another repository: nothing is read.
      automation.onWebhook('check_suite', { repository: { id: 999 } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(harness.github.requests.length).toBe(requests);

      // A comment on an issue (not a pull request) is not followed.
      automation.onWebhook('issue_comment', {
        repository: { id: remote.id },
        issue: { number: pull.number },
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(harness.github.requests.length).toBe(requests);

      addReview(pull, { body: 'One more thing' });
      automation.onWebhook('issue_comment', {
        repository: { id: remote.id },
        issue: { number: pull.number, pull_request: {} },
      });
      automation.onWebhook('pull_request_review_comment', {
        repository: { id: remote.id },
        pull_request: { number: pull.number },
      });
      automation.onWebhook('pull_request_review', {
        repository: { id: remote.id },
        pull_request: { number: pull.number },
      });
      await waitFor(() => appMessages().length === 2);
      expect(appMessages()[1].context?.text).toContain('One more thing');
    });
  });
});
