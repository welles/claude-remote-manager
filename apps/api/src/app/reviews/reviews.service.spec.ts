import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ReviewFinishedEvent,
  ReviewStartedEvent,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import type { AccountProvider } from '@claude-remote-manager/shared-types';
import type { AccountsService } from '../accounts/accounts.service';
import { AgentEngines, CODEX_CAPABILITIES } from '../agent/agent-engines';
import { AgentReviewRefused, type AgentAccount } from '../agent/agent-runner';
import { accounts, usageRecords as usageTable } from '../db/schema';
import { SessionEventRepository } from '../sessions/session-event.repository';
import { SessionDiffService } from '../diffs/session-diff.service';
import { commitFile } from '../git/testing/git-fixtures';
import {
  FakeAgentRunner,
  FakeTranscriptReader,
  flush,
  resultMessage,
  waitFor,
} from '../sessions/testing/fake-agent';
import { UsageRepository } from '../sessions/usage.repository';
import { WorkspaceHarness } from '../workspaces/testing/workspace-harness';
import { REVIEW_TOOLS } from '../agent/sdk-agent-runner';
import { ReviewDefaultsStore } from './review-defaults';
import { ReviewsService } from './reviews.service';

const finding = {
  severity: 'high',
  repository: 'alice/app',
  file: 'work.txt',
  line: 1,
  title: 'The value is wrong',
  detail: 'It should be `x`, see @foo.',
};

const usage = {
  'claude-fable-5-2': {
    inputTokens: 1000,
    outputTokens: 200,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsd: 0.5,
  },
};

describe('ReviewsService', () => {
  let harness: WorkspaceHarness;
  let reviews: ReviewsService;
  let defaults: ReviewDefaultsStore;
  let usageRecords: UsageRepository;
  let repositoryId: string;

  beforeEach(async () => {
    harness = new WorkspaceHarness();
    await harness.start();
    const repository = await harness.addRepository('alice', 'app');
    repositoryId = repository.id;
    defaults = new ReviewDefaultsStore(harness.db);
    usageRecords = new UsageRepository(harness.db);
    reviews = new ReviewsService(
      harness.service,
      harness.sessions,
      new SessionDiffService(harness.sessions),
      usageRecords,
      harness.runner,
      harness.hooks,
      defaults,
    );
    reviews.onModuleInit();
  });

  afterEach(async () => {
    reviews.onModuleDestroy();
    await harness.close();
  });

  /** A session whose first turn ended. */
  const idleSession = async (): Promise<SessionDto> => {
    const created = await harness.service.create({
      prompt: 'Work',
      repositories: [{ repositoryId }],
    });
    await harness.prepared(created.id);
    harness.runner.last.emit(resultMessage(10, 0.01));
    await waitFor(
      () => harness.service.get(created.id).waitingFor === 'message',
    );
    return harness.service.get(created.id);
  };

  /**
   * A turn of Claude that ends after `work` ran (waiting for a review that
   * runs then, or for the next message).
   */
  const turn = async (
    sessionId: string,
    work: () => Promise<unknown> = async () => undefined,
  ) => {
    await harness.service.sendMessage(sessionId, { text: 'Go on' });
    await waitFor(() => harness.service.get(sessionId).status === 'running');
    await work();
    harness.runner.last.emit(resultMessage(10, 0.01));
    await waitFor(() => harness.service.get(sessionId).status === 'waiting');
  };

  const reviewEvents = <T extends 'review.started' | 'review.finished'>(
    sessionId: string,
    type: T,
  ) =>
    harness.events
      .filter(
        (envelope) =>
          envelope.sessionId === sessionId && envelope.event.type === type,
      )
      .map(
        (envelope) =>
          envelope.event as T extends 'review.started'
            ? ReviewStartedEvent
            : ReviewFinishedEvent,
      );

  /** Messages the app sent to Claude with review findings. */
  const findingMessages = () =>
    harness.runner.runs.flatMap((run) =>
      run.sent.filter((message) =>
        message.text.startsWith('An independent review'),
      ),
    );

  it('reviews the session diff read-only with the default model and gives the findings to Claude', async () => {
    const session = await idleSession();
    await commitFile(session.cwd, 'work.txt', 'changed');
    await writeFile(join(session.cwd, 'new.txt'), 'untracked\n');

    const started = await reviews.start(session.id);
    expect(started).toMatchObject({
      trigger: 'manual',
      model: 'claude-fable-5-2',
      effort: 'high',
      fileCount: 2,
    });
    expect(harness.service.get(session.id).review?.running?.id).toBe(
      started.id,
    );
    expect(harness.hooks.reviewBusy?.(session.id)).toBe(true);
    const review = harness.runner.reviews[0];
    expect(review.options).toMatchObject({
      cwd: session.cwd,
      model: 'claude-fable-5-2',
      effort: 'high',
    });
    expect(review.options.prompt).toContain('+++ work.txt');
    expect(review.options.prompt).toContain('+++ new.txt');
    expect(review.options.prompt).toContain('+untracked');
    expect(REVIEW_TOOLS).toEqual(['Read', 'Grep', 'Glob']);
    expect(reviewEvents(session.id, 'review.started')).toEqual([
      expect.objectContaining({
        reviewId: started.id,
        trigger: 'manual',
        repositories: ['alice/app'],
      }),
    ]);

    review.finish({
      output: { summary: 'One problem.', findings: [finding] },
      modelUsage: usage,
      durationMs: 4000,
    });
    await waitFor(() => reviewEvents(session.id, 'review.finished').length > 0);
    const finished = reviewEvents(session.id, 'review.finished')[0];
    expect(finished).toMatchObject({
      reviewId: started.id,
      outcome: 'finished',
      summary: 'One problem.',
      error: null,
      durationMs: 4000,
      usage: expect.objectContaining({ inputTokens: 1000, costUsd: 0.5 }),
    });
    expect(finished.findings).toEqual([finding]);
    // The findings went to Claude as the app's message, with context.
    await waitFor(() => findingMessages().length === 1);
    const message = findingMessages()[0];
    expect(finished.messageId).toBe(message.id);
    expect(message.text).not.toContain('@');
    expect(message.context?.text).toContain('The value is wrong');
    expect(message.context?.text).toContain('untrusted');
    expect(harness.service.get(session.id).status).toBe('running');
    // The reviewer's usage counts for the session, but not as the
    // baseline of its Claude Code process.
    expect(usageRecords.totalsForSession(session.id).costUsd).toBeCloseTo(0.51);
    expect(
      usageRecords.totalsByModel(session.id)['claude-fable-5-2'],
    ).toBeUndefined();
    expect(harness.service.get(session.id).review?.running).toBeNull();
    expect(harness.hooks.reviewBusy?.(session.id)).toBe(false);
  });

  it('sends nothing to Claude without findings', async () => {
    const session = await idleSession();
    await commitFile(session.cwd, 'work.txt', 'changed');
    await reviews.start(session.id);
    // The session waits for the review instead of showing ready.
    expect(harness.service.get(session.id)).toMatchObject({
      status: 'waiting',
      waitingFor: 'background',
      waitingReason: 'Reviewing',
    });
    expect(harness.service.acceptsAppMessage(session.id)).toBe(true);
    harness.runner.reviews[0].finish({
      output: { summary: 'Looks right.', findings: [] },
    });
    await waitFor(() => reviewEvents(session.id, 'review.finished').length > 0);
    expect(reviewEvents(session.id, 'review.finished')[0]).toMatchObject({
      outcome: 'finished',
      findings: [],
      messageId: null,
    });
    await flush();
    expect(findingMessages()).toEqual([]);
    expect(harness.service.get(session.id)).toMatchObject({
      status: 'waiting',
      waitingFor: 'message',
      waitingReason: null,
    });
    // The history shows the wait and its end.
    expect(
      harness.events
        .filter(
          (envelope) =>
            envelope.sessionId === session.id &&
            envelope.event.type === 'session.status',
        )
        .slice(-2)
        .map((envelope) => envelope.event),
    ).toMatchObject([
      { type: 'session.status', status: 'waiting', waitingFor: 'background' },
      { type: 'session.status', status: 'waiting', waitingFor: 'message' },
    ]);
  });

  it('leaves a turn running during a review, and what Claude waits for comes first', async () => {
    const session = await idleSession();
    await commitFile(session.cwd, 'work.txt', 'changed');
    await reviews.start(session.id);
    const setWaiting = async (reason?: string) => {
      const tool = harness.runner.last.options.tools?.find(
        (entry) => entry.name === 'set_waiting_state',
      );
      if (!tool) {
        throw new Error('set_waiting_state is missing');
      }
      await tool.handler(
        { waiting_on: 'work', ...(reason ? { reason } : {}) },
        { toolUseId: 'toolu_wait' },
      );
    };

    await turn(session.id, async () => {
      expect(harness.service.get(session.id)).toMatchObject({
        status: 'running',
        waitingFor: null,
        waitingReason: null,
      });
      await setWaiting('CI of PR #1');
    });
    expect(harness.service.get(session.id)).toMatchObject({
      waitingFor: 'background',
      waitingReason: 'CI of PR #1',
    });

    // `work` without a reason: the review is what it waits for.
    await turn(session.id, () => setWaiting());
    expect(harness.service.get(session.id)).toMatchObject({
      waitingFor: 'background',
      waitingReason: 'Reviewing',
    });
  });

  it('publishes a review that starts once, as a status change', async () => {
    const session = await idleSession();
    await commitFile(session.cwd, 'work.txt', 'changed');
    const updates: SessionDto[] = [];
    const subscription = harness.service.updates$.subscribe((update) => {
      if (update.id === session.id) {
        updates.push(update);
      }
    });
    await reviews.start(session.id);
    subscription.unsubscribe();
    expect(
      updates.map((update) => [update.waitingFor, update.waitingReason]),
    ).toEqual([['background', 'Reviewing']]);
  });

  it('uses the model and effort chosen for the session', async () => {
    const session = await idleSession();
    await commitFile(session.cwd, 'work.txt', 'changed');
    defaults.update({ model: 'opus', effort: 'medium' });
    reviews.updateSession(session.id, { effort: 'max' });
    expect(harness.service.get(session.id).review).toMatchObject({
      model: null,
      effort: 'max',
    });
    const started = await reviews.start(session.id);
    expect(started).toMatchObject({ model: 'opus', effort: 'max' });
  });

  describe('engines', () => {
    let codex: FakeAgentRunner;
    let engines: AgentEngines;
    /** The accounts the reviews asked for, with their provider. */
    let leases: { accountId: string | null; provider?: AccountProvider }[];

    /** Accounts as the service picks them: own if of the provider. */
    const fakeAccounts = {
      withAccount: async <T>(
        accountId: string | null,
        task: (account: AgentAccount & { id: string }) => Promise<T>,
        options: { provider?: AccountProvider } = {},
      ) => {
        leases.push({ accountId, provider: options.provider });
        const provider = options.provider ?? 'claude';
        const id =
          accountId?.startsWith(`${provider}-`) === true
            ? accountId
            : `${provider}-default`;
        return task({ id, configDir: `/homes/${id}`, main: false });
      },
    } as unknown as AccountsService;

    /** The service again, with these engines (Codex unless `withCodex` is false). */
    const restart = (withCodex = true) => {
      reviews.onModuleDestroy();
      codex = new FakeAgentRunner();
      engines = new AgentEngines(harness.runner, harness.transcripts);
      if (withCodex) {
        engines.register('codex', {
          runner: codex,
          transcripts: new FakeTranscriptReader(),
          capabilities: CODEX_CAPABILITIES,
        });
      }
      leases = [];
      reviews = new ReviewsService(
        harness.service,
        harness.sessions,
        new SessionDiffService(harness.sessions),
        usageRecords,
        harness.runner,
        harness.hooks,
        defaults,
        fakeAccounts,
        engines,
      );
      reviews.onModuleInit();
    };

    /** A session with changes, working with Claude account `claude-a`. */
    const changedSession = async () => {
      const session = await idleSession();
      harness.db
        .insert(accounts)
        .values({
          id: 'claude-a',
          provider: 'claude',
          name: 'A',
          position: 5,
          directory: 'claude-a',
        })
        .onConflictDoNothing()
        .run();
      harness.sessions.update(session.id, { accountId: 'claude-a' });
      await commitFile(session.cwd, 'work.txt', 'changed');
      return session;
    };

    it('runs the reviewer with the engine of the settings, its model and an account of its provider', async () => {
      restart();
      const session = await changedSession();
      expect(reviews.updateDefaults({ engine: 'codex' })).toMatchObject({
        engine: 'codex',
        models: { codex: null },
      });
      const started = await reviews.start(session.id);
      expect(started).toMatchObject({
        engine: 'codex',
        fallbackFrom: null,
        model: null,
        effort: 'high',
      });
      expect(harness.runner.reviews).toHaveLength(0);
      const review = codex.reviews[0];
      expect(review.options).toMatchObject({
        cwd: session.cwd,
        model: null,
        effort: 'high',
        // The session's account is Claude's: the provider's default.
        account: { configDir: '/homes/chatgpt-default', main: false },
      });
      expect(review.options.instructions).toContain('sandbox is read-only');
      expect(leases).toEqual([{ accountId: 'claude-a', provider: 'chatgpt' }]);
      expect(reviewEvents(session.id, 'review.started')[0]).toMatchObject({
        engine: 'codex',
        fallbackFrom: null,
        model: null,
      });

      review.finish({
        output: { summary: 'One problem.', findings: [finding] },
        modelUsage: {
          'gpt-5.5-codex': { ...usage['claude-fable-5-2'], costUsd: 0 },
        },
        model: 'gpt-5.5-codex',
        effort: 'high',
      });
      await waitFor(() => findingMessages().length === 1);
      expect(findingMessages()[0].text).toContain(
        'a separate Codex process (model gpt-5.5-codex, effort high)',
      );
      const finished = reviewEvents(session.id, 'review.finished')[0];
      // The model Codex chose; the effort was the one asked for.
      expect(finished.model).toBe('gpt-5.5-codex');
      expect(finished).not.toHaveProperty('effort');
      // The usage counts for the session, with the reviewer's account.
      expect(
        harness.db
          .select()
          .from(usageTable)
          .all()
          .filter((row) => row.reviewId === started.id),
      ).toEqual([
        expect.objectContaining({
          model: 'gpt-5.5-codex',
          accountId: 'chatgpt-default',
        }),
      ]);
    });

    it('runs a Claude Code reviewer with the session’s own account', async () => {
      restart();
      const session = await changedSession();
      await reviews.start(session.id);
      expect(harness.runner.reviews[0].options).toMatchObject({
        model: 'claude-fable-5-2',
        account: { configDir: '/homes/claude-a' },
      });
      expect(leases).toEqual([{ accountId: 'claude-a', provider: 'claude' }]);
    });

    it('falls back to Claude Code when the server does not have the chosen engine', async () => {
      restart();
      const session = await changedSession();
      reviews.updateDefaults({ engine: 'codex', model: 'gpt-5.4' });
      reviews.updateSession(session.id, { model: 'gpt-5.5-codex' });
      // Codex is gone after a restart.
      restart(false);
      expect(reviews.getDefaults().engine).toBe('codex');
      const started = await reviews.start(session.id);
      expect(started).toMatchObject({
        engine: 'claude-code',
        fallbackFrom: 'codex',
        // Claude Code's model of the settings, not Codex's.
        model: 'claude-fable-5-2',
      });
      expect(harness.runner.reviews[0].options.model).toBe('claude-fable-5-2');
      expect(reviewEvents(session.id, 'review.started')[0]).toMatchObject({
        engine: 'claude-code',
        fallbackFrom: 'codex',
      });
      expect(() =>
        reviews.updateSession(session.id, { engine: 'codex' }),
      ).toThrow('not available on this server');
      expect(() => reviews.updateDefaults({ engine: 'codex' })).toThrow(
        'not available on this server',
      );
    });

    it('reviews with Claude Code when Codex refuses the session’s review, saying why', async () => {
      restart();
      const checked: unknown[] = [];
      codex.reviewBlocked = async (options) => {
        checked.push(options);
        return 'Codex has command rules (/homes/rules/default.rules)';
      };
      const session = await changedSession();
      reviews.updateDefaults({ engine: 'codex', effort: 'max' });
      const started = await reviews.start(session.id);
      expect(started).toMatchObject({
        engine: 'claude-code',
        fallbackFrom: 'codex',
        fallbackReason: 'Codex has command rules (/homes/rules/default.rules)',
        model: 'claude-fable-5-2',
        effort: 'max',
      });
      // Checked with the account the Codex reviewer would have had.
      expect(checked).toEqual([
        {
          account: { configDir: '/homes/chatgpt-default', main: false },
          cwd: session.cwd,
        },
      ]);
      expect(codex.reviews).toHaveLength(0);
      expect(harness.runner.reviews).toHaveLength(1);
      expect(reviewEvents(session.id, 'review.started')[0]).toMatchObject({
        fallbackFrom: 'codex',
        fallbackReason: 'Codex has command rules (/homes/rules/default.rules)',
      });
    });

    it('switches to Claude Code when Codex refuses the review as it starts', async () => {
      restart();
      codex.review = async () => {
        throw new AgentReviewRefused('Codex has command rules (late)');
      };
      const session = await changedSession();
      reviews.updateDefaults({ engine: 'codex' });
      const started = await reviews.start(session.id);
      expect(started.engine).toBe('codex');
      await waitFor(() => harness.runner.reviews.length === 1);
      expect(harness.service.get(session.id).review?.running).toMatchObject({
        engine: 'claude-code',
        fallbackFrom: 'codex',
        fallbackReason: 'Codex has command rules (late)',
        model: 'claude-fable-5-2',
      });
      expect(harness.runner.reviews[0].options).toMatchObject({
        model: 'claude-fable-5-2',
        account: { configDir: '/homes/claude-a' },
      });
      expect(harness.runner.reviews[0].options.instructions).toContain(
        'Read, Grep and Glob',
      );
      harness.runner.reviews[0].finish({
        output: { summary: 'Fine.', findings: [] },
      });
      await waitFor(
        () => reviewEvents(session.id, 'review.finished').length > 0,
      );
      expect(reviewEvents(session.id, 'review.finished')[0]).toMatchObject({
        outcome: 'finished',
        engine: 'claude-code',
        fallbackFrom: 'codex',
        fallbackReason: 'Codex has command rules (late)',
        model: 'claude-fable-5-2',
      });
    });

    it('keeps a session’s model with its engine and resets it when the engine changes', async () => {
      restart();
      const session = await changedSession();
      const review = () => harness.service.get(session.id).review;
      // A model chosen with the app's engine keeps that engine.
      reviews.updateSession(session.id, { model: 'opus' });
      expect(review()).toMatchObject({ engine: 'claude-code', model: 'opus' });
      reviews.updateDefaults({ engine: 'codex' });
      expect(reviews.reviewer(harness.sessions.require(session.id))).toEqual({
        engine: 'claude-code',
        fallbackFrom: null,
        fallbackReason: null,
        model: 'opus',
        effort: 'high',
      });
      // Another engine resets the model.
      reviews.updateSession(session.id, { engine: 'codex' });
      expect(review()).toMatchObject({ engine: 'codex', model: null });
      reviews.updateSession(session.id, { model: 'gpt-5.4', effort: 'max' });
      expect(review()).toMatchObject({
        engine: 'codex',
        model: 'gpt-5.4',
        effort: 'max',
      });
      // The same engine again keeps it.
      reviews.updateSession(session.id, { engine: 'codex' });
      expect(review()?.model).toBe('gpt-5.4');
      await reviews.start(session.id);
      expect(codex.reviews[0].options).toMatchObject({
        model: 'gpt-5.4',
        effort: 'max',
      });
      // Back to the app's engine (Codex now) and its model.
      reviews.updateSession(session.id, { engine: null });
      expect(review()).toMatchObject({ engine: null, model: null });
      expect(reviews.reviewer(harness.sessions.require(session.id))).toEqual({
        engine: 'codex',
        fallbackFrom: null,
        fallbackReason: null,
        model: null,
        effort: 'max',
      });
      expect(() =>
        reviews.updateSession(session.id, {
          engine: 'gemini' as unknown as 'codex',
        }),
      ).toThrow('engine must be one of');
    });
  });

  it('refuses a review without changes and a second one while one runs', async () => {
    const session = await idleSession();
    await expect(reviews.start(session.id)).rejects.toThrow(
      'no changes to review',
    );
    await commitFile(session.cwd, 'work.txt', 'changed');
    await reviews.start(session.id);
    await expect(reviews.start(session.id)).rejects.toThrow(
      'A review of this session is running',
    );
  });

  it('cancels a running review', async () => {
    const session = await idleSession();
    await commitFile(session.cwd, 'work.txt', 'changed');
    await reviews.start(session.id);
    reviews.cancel(session.id);
    await waitFor(() => reviewEvents(session.id, 'review.finished').length > 0);
    expect(reviewEvents(session.id, 'review.finished')[0]).toMatchObject({
      outcome: 'cancelled',
      messageId: null,
    });
    expect(() => reviews.cancel(session.id)).toThrow('No review');
    // Ready again once it is over.
    await waitFor(
      () => harness.service.get(session.id).waitingFor === 'message',
    );
    expect(harness.service.get(session.id).waitingReason).toBeNull();
  });

  it('reports a reviewer that gives no usable answer', async () => {
    const session = await idleSession();
    await commitFile(session.cwd, 'work.txt', 'changed');
    await reviews.start(session.id);
    harness.runner.reviews[0].finish({
      output: null,
      error: 'error_max_turns',
    });
    await waitFor(() => reviewEvents(session.id, 'review.finished').length > 0);
    expect(reviewEvents(session.id, 'review.finished')[0]).toMatchObject({
      outcome: 'failed',
      error: 'error_max_turns',
    });
  });

  describe('requests by Claude', () => {
    /** Claude calls `request_review` in the running process. */
    const request = async () => {
      const tool = harness.runner.last.options.tools?.find(
        (entry) => entry.name === 'request_review',
      );
      if (!tool) {
        throw new Error('request_review is missing');
      }
      return (await tool.handler({}, { toolUseId: 'toolu_review' })).text;
    };

    it('offers the tool without asking and starts a review when Claude asks', async () => {
      const session = await idleSession();
      expect(harness.service.get(session.id).review?.mode).toBe('claude');
      expect(harness.runner.last.options.allowedTools).toContain(
        'mcp__crm__request_review',
      );
      await turn(session.id, async () => {
        await commitFile(session.cwd, 'work.txt', 'changed');
        expect(await request()).toContain('The independent review started');
        await expect(request()).rejects.toThrow('already runs');
      });
      expect(harness.runner.reviews).toHaveLength(1);
      expect(reviewEvents(session.id, 'review.started')[0].trigger).toBe(
        'claude',
      );
      harness.runner.reviews[0].finish({
        output: { summary: null, findings: [finding] },
      });
      await waitFor(() => findingMessages().length === 1);
    });

    it('tells Claude when the review it asked for found nothing or failed', async () => {
      const session = await idleSession();
      const outcomes = () =>
        harness.runner.runs.flatMap((run) =>
          run.sent
            .map((message) => message.text)
            .filter((text) => text.includes('you asked for')),
        );
      await turn(session.id, async () => {
        await commitFile(session.cwd, 'work.txt', 'one');
        await request();
      });
      harness.runner.reviews[0].finish({
        output: { summary: 'Fine.', findings: [] },
      });
      await waitFor(() => outcomes().length === 1);
      expect(outcomes()[0]).toContain('found no issues');
      expect(
        reviewEvents(session.id, 'review.finished')[0].messageId,
      ).not.toBeNull();
      harness.runner.last.emit(resultMessage(10, 0.01));
      await waitFor(
        () => harness.service.get(session.id).waitingFor === 'message',
      );
      await turn(session.id, async () => {
        await commitFile(session.cwd, 'work.txt', 'two');
        await request();
      });
      harness.runner.reviews[1].finish({ output: null, error: 'broken' });
      await waitFor(() => outcomes().length === 2);
      expect(outcomes()[1]).toContain('failed');
      expect(outcomes()[1]).not.toContain('broken');
    });

    it('sends nothing to a session that ended meanwhile', async () => {
      const session = await idleSession();
      await turn(session.id, async () => {
        await commitFile(session.cwd, 'work.txt', 'one');
        await request();
      });
      await harness.service.end(session.id);
      harness.runner.reviews[0].finish({
        output: { summary: null, findings: [finding] },
      });
      // The ended session is not live: its events are only stored.
      const stored = () =>
        new SessionEventRepository(harness.db)
          .list(session.id)
          .map(({ event }) => event);
      await waitFor(() =>
        stored().some((event) => event.type === 'review.finished'),
      );
      expect(stored()).toContainEqual(
        expect.objectContaining({ type: 'review.finished', messageId: null }),
      );
      expect(stored()).toContainEqual(
        expect.objectContaining({
          type: 'notice',
          text: expect.stringContaining('were not sent to Claude'),
        }),
      );
      expect(findingMessages()).toEqual([]);
      expect(harness.service.get(session.id).status).toBe('finished');
    });

    it('refuses in a session without repository', async () => {
      const created = await harness.service.create({
        prompt: 'Work',
        scratch: true,
      });
      await harness.prepared(created.id);
      await expect(request()).rejects.toThrow('no repository');
    });

    it('does not review after each turn in this mode', async () => {
      const session = await idleSession();
      await turn(session.id, () =>
        commitFile(session.cwd, 'work.txt', 'changed'),
      );
      await flush();
      expect(harness.runner.reviews).toHaveLength(0);
    });

    it('refuses when reviews are off or nothing is new, and has no round limit', async () => {
      const session = await idleSession();
      await harness.service.sendMessage(session.id, { text: 'Go on' });
      await waitFor(() => harness.service.get(session.id).status === 'running');
      await expect(request()).rejects.toThrow('nothing to review');
      await commitFile(session.cwd, 'work.txt', 'changed');
      reviews.updateSession(session.id, { mode: 'off' });
      await expect(request()).rejects.toThrow('turned independent reviews off');
      reviews.updateSession(session.id, { mode: 'claude' });
      await request();
      harness.runner.reviews[0].finish({
        output: { summary: null, findings: [] },
      });
      await waitFor(() => !harness.hooks.reviewBusy?.(session.id));
      await expect(request()).rejects.toThrow('reviewed already');
      await commitFile(session.cwd, 'work.txt', 'again');
      await request();
      harness.runner.reviews[1].finish({
        output: { summary: null, findings: [finding] },
      });
      await waitFor(() => !harness.hooks.reviewBusy?.(session.id));
      // Rounds with findings in a row do not stop further requests.
      await commitFile(session.cwd, 'work.txt', 'third');
      await request();
      expect(harness.runner.reviews).toHaveLength(3);
    });
  });

  describe('auto-review', () => {
    it('checks the mode and reviews at once when switched on after a turn', async () => {
      const session = await idleSession();
      expect(() =>
        reviews.updateSession(session.id, {
          mode: 'sometimes' as unknown as 'turn',
        }),
      ).toThrow('mode must be one of');
      await commitFile(session.cwd, 'work.txt', 'changed');
      reviews.updateSession(session.id, { mode: 'turn' });
      await waitFor(() => harness.runner.reviews.length === 1);
      expect(harness.service.get(session.id).review?.running?.trigger).toBe(
        'auto',
      );
    });

    it('reviews after a turn that changed the diff, and not again for the same diff', async () => {
      const session = await idleSession();
      reviews.updateSession(session.id, { mode: 'turn' });
      // Nothing changed yet.
      await flush();
      await waitFor(() => !harness.hooks.reviewBusy?.(session.id));
      expect(harness.runner.reviews).toHaveLength(0);

      await turn(session.id, () =>
        commitFile(session.cwd, 'work.txt', 'changed'),
      );
      await waitFor(() => harness.runner.reviews.length === 1);
      expect(harness.service.get(session.id).review?.running?.trigger).toBe(
        'auto',
      );
      harness.runner.reviews[0].finish({
        output: { summary: 'Fine.', findings: [] },
      });
      await waitFor(
        () => harness.service.get(session.id).review?.running === null,
      );

      // A turn without changes: no new review.
      await turn(session.id);
      await flush();
      await waitFor(() => !harness.hooks.reviewBusy?.(session.id));
      expect(harness.runner.reviews).toHaveLength(1);
    });

    it('keeps reviewing after rounds with findings, without a limit', async () => {
      const session = await idleSession();
      reviews.updateSession(session.id, { mode: 'turn' });
      await turn(session.id, () => commitFile(session.cwd, 'work.txt', 'one'));
      await waitFor(() => harness.runner.reviews.length === 1);
      harness.runner.reviews[0].finish({
        output: { summary: null, findings: [finding] },
      });
      // The findings start Claude's fixing turn.
      await waitFor(() => findingMessages().length === 1);
      await waitFor(() => harness.service.get(session.id).status === 'running');
      // The fixing turn changed the diff: the next review follows.
      await commitFile(session.cwd, 'work.txt', 'two');
      harness.runner.last.emit(resultMessage(10, 0.01));
      await waitFor(() => harness.runner.reviews.length === 2);
      harness.runner.reviews[1].finish({
        output: { summary: null, findings: [finding] },
      });
      await waitFor(() => findingMessages().length === 2);
    });
    it('reviews a diff that changed while a manual review ran, once that one ends', async () => {
      const session = await idleSession();
      await commitFile(session.cwd, 'work.txt', 'one');
      await reviews.start(session.id);
      reviews.updateSession(session.id, { mode: 'turn' });
      // The turn ends while the manual review runs: no second review yet.
      await turn(session.id, () => commitFile(session.cwd, 'work.txt', 'two'));
      await flush();
      expect(harness.runner.reviews).toHaveLength(1);
      harness.runner.reviews[0].finish({
        output: { summary: null, findings: [] },
      });
      await waitFor(() => harness.runner.reviews.length === 2);
      expect(harness.runner.reviews[1].options.prompt).toContain('+two');
    });
  });

  it('counts as busy until the findings went to Claude', async () => {
    const session = await idleSession();
    await commitFile(session.cwd, 'work.txt', 'changed');
    await reviews.start(session.id);
    const busyWhenSent: boolean[] = [];
    const send = harness.service.sendMessage.bind(harness.service);
    jest
      .spyOn(harness.service, 'sendMessage')
      .mockImplementation(async (id, input) => {
        busyWhenSent.push(harness.hooks.reviewBusy?.(id) ?? false);
        await send(id, input);
      });
    harness.runner.reviews[0].finish({
      output: { summary: null, findings: [finding] },
    });
    await waitFor(() => reviewEvents(session.id, 'review.finished').length > 0);
    expect(busyWhenSent).toEqual([true]);
    await waitFor(() => !harness.hooks.reviewBusy?.(session.id));
  });

  it('stops a review when the session is archived and sends nothing', async () => {
    const session = await idleSession();
    await commitFile(session.cwd, 'work.txt', 'changed');
    await reviews.start(session.id);
    harness.service.setArchived(session.id, new Date());
    await waitFor(() => reviewEvents(session.id, 'review.finished').length > 0);
    expect(reviewEvents(session.id, 'review.finished')[0].outcome).toBe(
      'cancelled',
    );
    expect(findingMessages()).toEqual([]);
    await expect(reviews.start(session.id)).rejects.toThrow(
      'cannot be reviewed',
    );
  });

  it('stops a review that takes too long', async () => {
    reviews.timeoutMs = 20;
    const session = await idleSession();
    await commitFile(session.cwd, 'work.txt', 'changed');
    await reviews.start(session.id);
    await waitFor(() => reviewEvents(session.id, 'review.finished').length > 0);
    expect(reviewEvents(session.id, 'review.finished')[0]).toMatchObject({
      outcome: 'failed',
      error: expect.stringContaining('took longer than'),
    });
  });
});
