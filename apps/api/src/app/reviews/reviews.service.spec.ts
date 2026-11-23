import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ReviewFinishedEvent,
  ReviewStartedEvent,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { SessionDiffService } from '../diffs/session-diff.service';
import { commitFile } from '../git/testing/git-fixtures';
import { flush, resultMessage, waitFor } from '../sessions/testing/fake-agent';
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
    costUSD: 0.5,
    webSearchRequests: 0,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
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

  /** A turn of Claude that ends after `work` ran. */
  const turn = async (
    sessionId: string,
    work: () => Promise<unknown> = async () => undefined,
  ) => {
    await harness.service.sendMessage(sessionId, { text: 'Go on' });
    await waitFor(() => harness.service.get(sessionId).status === 'running');
    await work();
    harness.runner.last.emit(resultMessage(10, 0.01));
    await waitFor(
      () => harness.service.get(sessionId).waitingFor === 'message',
    );
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
    expect(harness.service.get(session.id).status).toBe('waiting');
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

  describe('auto-review', () => {
    it('reviews after a turn that changed the diff, and not again for the same diff', async () => {
      const session = await idleSession();
      reviews.updateSession(session.id, { autoReview: true });
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

    it('stops after the round limit until the user writes', async () => {
      defaults.update({ maxAutoRounds: 1 });
      const session = await idleSession();
      reviews.updateSession(session.id, { autoReview: true });
      await turn(session.id, () => commitFile(session.cwd, 'work.txt', 'one'));
      await waitFor(() => harness.runner.reviews.length === 1);
      harness.runner.reviews[0].finish({
        output: { summary: null, findings: [finding] },
      });
      // The findings start Claude's fixing turn.
      await waitFor(() => findingMessages().length === 1);
      await waitFor(() => harness.service.get(session.id).status === 'running');
      expect(harness.service.get(session.id).review?.autoRounds).toBe(1);
      expect(
        harness.events.some(
          (envelope) =>
            envelope.event.type === 'notice' &&
            envelope.event.text.includes('pauses until your next message'),
        ),
      ).toBe(true);
      await commitFile(session.cwd, 'work.txt', 'two');
      harness.runner.last.emit(resultMessage(10, 0.01));
      await waitFor(
        () => harness.service.get(session.id).waitingFor === 'message',
      );
      await flush();
      expect(harness.runner.reviews).toHaveLength(1);

      // The user writes: the rounds start over.
      await harness.service.send(session.id, { text: 'Thanks' });
      expect(harness.service.get(session.id).review?.autoRounds).toBe(0);
      harness.runner.last.emit(resultMessage(10, 0.01));
      await waitFor(() => harness.runner.reviews.length === 2);
    });
    it('reviews a diff that changed while a manual review ran, once that one ends', async () => {
      const session = await idleSession();
      await commitFile(session.cwd, 'work.txt', 'one');
      await reviews.start(session.id);
      reviews.updateSession(session.id, { autoReview: true });
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
