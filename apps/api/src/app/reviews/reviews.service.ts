import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Subscription } from 'rxjs';
import type {
  ReviewDefaults,
  ReviewEffort,
  ReviewFinding,
  ReviewOutcome,
  ReviewTrigger,
  RunningReviewDto,
  SessionDiffResponse,
  SessionDto,
  UpdateSessionReviewRequest,
  UsageTotals,
} from '@claude-remote-manager/shared-types';
import { AgentRunner } from '../agent/agent-runner';
import { requireObject } from '../common/validation';
import { SessionDiffService } from '../diffs/session-diff.service';
import { SessionAutomationHooks } from '../sessions/session-automation-hooks';
import {
  additionalDirectories,
  isActiveDirectory,
  SessionRepository,
  workingDirectory,
  type SessionRecord,
} from '../sessions/session.repository';
import { SessionsService } from '../sessions/sessions.service';
import { sumUsage, UsageTracker } from '../sessions/usage-tracker';
import { UsageRepository } from '../sessions/usage.repository';
import {
  ReviewDefaultsStore,
  requireReviewEffort,
  requireReviewModel,
} from './review-defaults';
import {
  changedFileCount,
  changedRepositories,
  diffFingerprint,
  findingsContext,
  findingsMessage,
  parseReviewOutput,
  REVIEW_SCHEMA,
  REVIEWER_INSTRUCTIONS,
  reviewPrompt,
} from './review-prompt';

/** A review that runs. */
interface ActiveReview {
  dto: RunningReviewDto;
  abort: AbortController;
}

/** How long a review may take. */
export const REVIEW_TIMEOUT_MS = 30 * 60_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Independent reviews of sessions' changes: a separate, read-only Claude
 * Code process (see `AgentRunner.review`) with a model and effort of its
 * own gets the session diff, and its findings go to the session's Claude
 * as a message of the app. Started by the user, or by auto-review after a
 * turn that changed the diff.
 */
@Injectable()
export class ReviewsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Reviews');
  /** Running reviews by session. */
  private readonly active = new Map<string, ActiveReview>();
  /** Sessions where a review is being prepared (diff computed). */
  private readonly starting = new Set<string>();
  /** Whether each session's turn was over at its last update. */
  private readonly turnOver = new Map<string, boolean>();
  private readonly subscriptions: Subscription[] = [];
  /** A review taking longer is stopped and fails (tests shorten it). */
  timeoutMs = REVIEW_TIMEOUT_MS;
  /** The module is shutting down: nothing starts any more. */
  private stopped = false;

  constructor(
    private readonly sessions: SessionsService,
    private readonly records: SessionRepository,
    private readonly diffs: SessionDiffService,
    private readonly usage: UsageRepository,
    private readonly runner: AgentRunner,
    private readonly hooks: SessionAutomationHooks,
    private readonly defaults: ReviewDefaultsStore,
  ) {}

  onModuleInit(): void {
    this.hooks.runningReview = (sessionId) =>
      this.active.get(sessionId)?.dto ?? null;
    this.hooks.reviewBusy = (sessionId) =>
      this.active.has(sessionId) || this.starting.has(sessionId);
    this.subscriptions.push(
      this.sessions.updates$.subscribe((session) =>
        this.sessionChanged(session),
      ),
      this.sessions.ownerMessages$.subscribe((sessionId) =>
        this.ownerMessage(sessionId),
      ),
      this.sessions.deletions$.subscribe((sessionId) => {
        this.active.get(sessionId)?.abort.abort();
        this.turnOver.delete(sessionId);
      }),
    );
  }

  onModuleDestroy(): void {
    this.stopped = true;
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
    for (const review of this.active.values()) {
      review.abort.abort();
    }
    this.hooks.runningReview = null;
    this.hooks.reviewBusy = null;
  }

  // --- Settings ------------------------------------------------------------

  getDefaults(): ReviewDefaults {
    return this.defaults.get();
  }

  updateDefaults(request: unknown): ReviewDefaults {
    return this.defaults.update(requireObject(request));
  }

  /** Changes a session's review settings; turning auto-review on may start one. */
  updateSession(sessionId: string, request: unknown): SessionDto {
    const body = requireObject(request) as Record<string, unknown> &
      UpdateSessionReviewRequest;
    const record = this.requireRecord(sessionId);
    const patch: Partial<
      Pick<
        SessionRecord,
        'autoReview' | 'reviewModel' | 'reviewEffort' | 'autoReviewRounds'
      >
    > = {};
    if (body.autoReview !== undefined) {
      if (typeof body.autoReview !== 'boolean') {
        throw new BadRequestException('autoReview must be a boolean');
      }
      patch.autoReview = body.autoReview;
      if (body.autoReview && !record.autoReview) {
        // Switched on: the rounds start over.
        patch.autoReviewRounds = 0;
      }
    }
    if (body.model !== undefined) {
      patch.reviewModel =
        body.model === null ? null : requireReviewModel(body.model, 'model');
    }
    if (body.effort !== undefined) {
      patch.reviewEffort =
        body.effort === null
          ? null
          : requireReviewEffort(body.effort, 'effort');
    }
    this.records.update(sessionId, patch);
    const session = this.sessions.get(sessionId);
    this.sessions.publishUpdate(sessionId);
    if (patch.autoReview && this.isTurnOver(session)) {
      void this.autoReview(sessionId);
    }
    return this.sessions.get(sessionId);
  }

  // --- Reviews -------------------------------------------------------------

  /** Starts a review by the user (409 when one runs or nothing changed). */
  async start(sessionId: string): Promise<RunningReviewDto> {
    const record = this.requireRecord(sessionId);
    this.requireReviewable(record);
    if (this.active.has(sessionId) || this.starting.has(sessionId)) {
      throw new ConflictException('A review of this session is running');
    }
    this.starting.add(sessionId);
    try {
      const diff = await this.diffs.sessionDiff(sessionId);
      if (changedRepositories(diff).length === 0) {
        throw new ConflictException(
          'The session has no changes to review (against the base branches)',
        );
      }
      // Archived or cleaned up meanwhile?
      const current = this.requireRecord(sessionId);
      this.requireReviewable(current);
      return this.launch(current, diff, 'manual');
    } finally {
      this.starting.delete(sessionId);
      if (!this.active.has(sessionId) && this.records.get(sessionId)) {
        // No review: PR automation that waited looks again.
        this.sessions.publishUpdate(sessionId);
      }
    }
  }

  /** Stops the running review (409 without). */
  cancel(sessionId: string): void {
    this.requireRecord(sessionId);
    const review = this.active.get(sessionId);
    if (!review) {
      throw new ConflictException('No review of this session is running');
    }
    review.abort.abort();
  }

  private launch(
    record: SessionRecord,
    diff: SessionDiffResponse,
    trigger: ReviewTrigger,
  ): RunningReviewDto {
    const defaults = this.defaults.get();
    const model = record.reviewModel ?? defaults.model;
    const effort = record.reviewEffort ?? defaults.effort;
    const dto: RunningReviewDto = {
      id: randomUUID(),
      trigger,
      model,
      effort,
      startedAt: new Date().toISOString(),
      fileCount: changedFileCount(diff),
    };
    const abort = new AbortController();
    this.active.set(record.id, { dto, abort });
    // The session shows the review as running before its card appears.
    this.sessions.publishUpdate(record.id);
    this.sessions.recordEvent(record.id, {
      type: 'review.started',
      reviewId: dto.id,
      trigger,
      model,
      effort,
      fileCount: dto.fileCount,
      repositories: changedRepositories(diff).map(
        (repository) => repository.repository,
      ),
    });
    this.logger.log(
      `Review ${dto.id} of session ${record.id} started (${trigger}, ${model}, ${effort})`,
    );
    void this.run(record, diff, dto, abort, defaults.maxAutoRounds)
      .catch((failure: unknown) =>
        this.logger.error(
          `Review ${dto.id} of session ${record.id} broke: ${errorText(failure)}`,
        ),
      )
      .finally(() => this.ended(record.id, dto.id));
    return dto;
  }

  /**
   * A review is over (its findings delivered, or it failed): the session is
   * free for the PR automation, and auto-review looks whether the diff
   * changed meanwhile (e.g. by a turn that ended while the review ran).
   */
  private ended(sessionId: string, reviewId: string): void {
    if (this.active.get(sessionId)?.dto.id === reviewId) {
      this.active.delete(sessionId);
    }
    if (this.stopped || !this.records.get(sessionId)) {
      return;
    }
    const session = this.sessions.get(sessionId);
    this.sessions.publishUpdate(sessionId);
    if (session.review?.autoReview && this.isTurnOver(session)) {
      void this.autoReview(sessionId);
    }
  }

  /**
   * Runs the reviewer and hands its findings to Claude. The review counts
   * as running (see `reviewBusy`) until the findings were delivered.
   */
  private async run(
    record: SessionRecord,
    diff: SessionDiffResponse,
    dto: RunningReviewDto,
    abort: AbortController,
    maxAutoRounds: number,
  ): Promise<void> {
    const sessionId = record.id;
    const started = Date.now();
    let outcome: ReviewOutcome = 'failed';
    let summary: string | null = null;
    let findings: ReviewFinding[] = [];
    let error: string | null = null;
    let usage: UsageTotals | null = null;
    let durationMs = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.timeoutMs);
    timer.unref?.();
    try {
      const result = await this.runner.review({
        cwd: workingDirectory(record),
        additionalDirectories: additionalDirectories(record),
        model: dto.model,
        effort: dto.effort as ReviewEffort,
        prompt: reviewPrompt(diff),
        instructions: REVIEWER_INSTRUCTIONS,
        schema: REVIEW_SCHEMA,
        signal: abort.signal,
      });
      durationMs = result.durationMs;
      const byModel = new UsageTracker().consume(result.modelUsage);
      if (Object.keys(byModel).length > 0) {
        usage = sumUsage(Object.values(byModel));
        if (this.records.get(sessionId)) {
          this.usage.record(sessionId, null, byModel, new Date(), dto.id);
        }
      }
      const parsed = result.error ? null : parseReviewOutput(result.output);
      if (abort.signal.aborted) {
        // Stopped, though the process still answered.
        throw new Error('aborted');
      }
      if (parsed) {
        outcome = 'finished';
        summary = parsed.summary;
        findings = parsed.findings;
      } else {
        error = result.error ?? 'The reviewer gave no usable answer';
      }
    } catch (failure) {
      durationMs ||= Date.now() - started;
      if (timedOut) {
        error = `The review took longer than ${Math.round(this.timeoutMs / 60_000)} minutes and was stopped`;
      } else if (abort.signal.aborted) {
        outcome = 'cancelled';
      } else {
        error = errorText(failure);
      }
    } finally {
      clearTimeout(timer);
    }
    const current = this.records.get(sessionId);
    if (!current) {
      // Deleted meanwhile.
      return;
    }
    let messageId: string | null = null;
    if (outcome === 'finished') {
      const rounds =
        findings.length === 0
          ? 0
          : dto.trigger === 'auto'
            ? current.autoReviewRounds + 1
            : current.autoReviewRounds;
      this.records.update(sessionId, {
        reviewedDiff: diffFingerprint(diff),
        autoReviewRounds: rounds,
      });
      if (findings.length > 0) {
        messageId = await this.deliver(current, dto, summary, findings);
      }
    }
    this.sessions.recordEvent(sessionId, {
      type: 'review.finished',
      reviewId: dto.id,
      outcome,
      summary,
      findings,
      error,
      durationMs,
      usage,
      messageId,
    });
    const after = this.records.get(sessionId);
    if (
      outcome === 'finished' &&
      findings.length > 0 &&
      dto.trigger === 'auto' &&
      after &&
      after.autoReview &&
      after.autoReviewRounds >= maxAutoRounds
    ) {
      this.sessions.recordEvent(sessionId, {
        type: 'notice',
        level: 'info',
        text: `Auto-review found issues ${after.autoReviewRounds} times in a row and pauses until your next message.`,
      });
    }
    this.logger.log(
      `Review ${dto.id} of session ${sessionId} ${outcome}${outcome === 'finished' ? ` with ${findings.length} findings` : ''}${error ? `: ${error}` : ''}`,
    );
  }

  /**
   * Sends the findings to Claude; the message's ID, `null` if they were not
   * sent. Never to an archived session, and an auto-review's findings not
   * to a session that ended meanwhile (they would continue it): the card
   * shows them.
   */
  private async deliver(
    record: SessionRecord,
    dto: RunningReviewDto,
    summary: string | null,
    findings: ReviewFinding[],
  ): Promise<string | null> {
    const sessionId = record.id;
    if (
      record.archivedAt !== null ||
      (dto.trigger === 'auto' && record.status === 'finished')
    ) {
      this.sessions.recordEvent(sessionId, {
        type: 'notice',
        level: 'info',
        text: `The session ${record.archivedAt !== null ? 'was archived' : 'ended'}: the review's findings were not sent to Claude.`,
      });
      return null;
    }
    const id = randomUUID();
    try {
      await this.sessions.sendMessage(sessionId, {
        id,
        text: findingsMessage(findings.length, dto.model, dto.effort),
        origin: 'app',
        untrusted: findingsContext(summary, findings),
      });
      return id;
    } catch (failure) {
      this.logger.warn(
        `The findings of review ${dto.id} could not go to session ${sessionId}: ${errorText(failure)}`,
      );
      this.sessions.recordEvent(sessionId, {
        type: 'notice',
        level: 'warning',
        text: `The review's findings could not be sent to Claude: ${errorText(failure)}`,
      });
      return null;
    }
  }

  // --- Auto-review -----------------------------------------------------------

  /**
   * Whether the session's turn is over in the sense of auto-review: it
   * waits for a message, or only for what Claude goes on with by itself.
   */
  private isTurnOver(session: SessionDto): boolean {
    return (
      session.status === 'waiting' &&
      this.sessions.acceptsAppMessage(session.id)
    );
  }

  private sessionChanged(session: SessionDto): void {
    if (session.archivedAt !== null) {
      // Archiving ends the session and may remove its clones.
      this.active.get(session.id)?.abort.abort();
    }
    const over = this.isTurnOver(session);
    const before = this.turnOver.get(session.id) ?? false;
    this.turnOver.set(session.id, over);
    if (over && !before && session.review?.autoReview) {
      void this.autoReview(session.id);
    }
  }

  /** Starts an auto-review if the diff changed since the last review. */
  private async autoReview(sessionId: string): Promise<void> {
    if (
      this.stopped ||
      this.active.has(sessionId) ||
      this.starting.has(sessionId)
    ) {
      return;
    }
    const record = this.records.get(sessionId);
    if (
      !record?.autoReview ||
      !this.reviewable(record) ||
      record.autoReviewRounds >= this.defaults.get().maxAutoRounds
    ) {
      return;
    }
    this.starting.add(sessionId);
    try {
      const diff = await this.diffs.sessionDiff(sessionId);
      const fingerprint = diffFingerprint(diff);
      const current = this.records.get(sessionId);
      if (
        !current?.autoReview ||
        !this.reviewable(current) ||
        current.reviewedDiff === fingerprint ||
        changedRepositories(diff).length === 0 ||
        // A turn started meanwhile: auto-review follows its end.
        !this.isTurnOver(this.sessions.get(sessionId))
      ) {
        return;
      }
      this.launch(current, diff, 'auto');
    } catch (failure) {
      this.logger.warn(
        `Auto-review of session ${sessionId} could not start: ${errorText(failure)}`,
      );
    } finally {
      this.starting.delete(sessionId);
      // Waiting PR automation looks again.
      if (
        !this.stopped &&
        !this.active.has(sessionId) &&
        this.records.get(sessionId)
      ) {
        this.sessions.publishUpdate(sessionId);
      }
    }
  }

  /** The owner wrote: auto-review's rounds start over. */
  private ownerMessage(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (record && record.autoReviewRounds > 0) {
      this.records.update(sessionId, { autoReviewRounds: 0 });
      this.sessions.publishUpdate(sessionId);
    }
  }

  // --- Helpers ---------------------------------------------------------------

  private requireRecord(sessionId: string): SessionRecord {
    const record = this.records.get(sessionId);
    if (!record) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    return record;
  }

  /** Whether the session's clones can be reviewed. */
  private reviewable(record: SessionRecord): boolean {
    return (
      record.archivedAt === null &&
      record.status !== 'preparing' &&
      record.directories.some((directory) => directory.kind === 'clone') &&
      record.directories.every(
        (directory) =>
          !isActiveDirectory(directory) || directory.state === 'ready',
      )
    );
  }

  private requireReviewable(record: SessionRecord): void {
    if (!this.reviewable(record)) {
      throw new ConflictException(
        record.directories.some((directory) => directory.kind === 'clone')
          ? 'The session cannot be reviewed now (archived, being prepared, or its clones are not all there)'
          : 'Only sessions with repositories can be reviewed',
      );
    }
  }
}
