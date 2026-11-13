import { readdir, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import {
  AUTOFIX_MAX_ATTEMPTS_RANGE,
  type AutofixTrigger,
  type CloneLossReport,
  type GitPushAnalysis,
  type SessionDto,
  type UpdatePullRequestAutomationRequest,
} from '@claude-remote-manager/shared-types';
import { requireObject } from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DevServers } from '../dev-servers/dev-servers';
import { GitService } from '../git/git.service';
import { GitHubRateLimitError } from '../github/github-errors';
import { GitHubService } from '../github/github.service';
import { NotificationsService } from '../notifications/notifications.service';
import { isGitHubRepository } from '../repositories/repository-credentials';
import { RepositoryRepository } from '../repositories/repository.repository';
import { pullRequestDto } from '../sessions/pull-request-dto';
import {
  SessionAutomationHooks,
  type AutoPushOutcome,
} from '../sessions/session-automation-hooks';
import { SessionGitService } from '../sessions/session-git.service';
import {
  SessionRepository,
  workingDirectory,
  type PullRequestRecord,
  type SessionDirectoryRecord,
  type SessionRecord,
} from '../sessions/session.repository';
import { SessionsService } from '../sessions/sessions.service';
import {
  autofixContext,
  autofixMessage,
  failedChecks,
  logExcerpt,
  pendingChecks,
  type FailedCheck,
} from './autofix-context';
import {
  PullRequestFeedback,
  type FeedbackRepository,
  type ReviewFeedback,
} from './pull-request-feedback';
import { WebhookHandler } from './webhook.controller';

/** Polling without webhook secret, and as backstop with one. */
export const DEFAULT_POLL_MS = 2 * 60_000;
export const BACKSTOP_POLL_MS = 15 * 60_000;
/** Deliveries for one pull request within this time cause one check. */
export const WEBHOOK_DEBOUNCE_MS = 15_000;
/** A check after the session became idle again (events wait meanwhile). */
export const IDLE_RECHECK_MS = 3_000;
/**
 * Failed checks wait for the other checks of the commit to finish (one run
 * for all of them), at most this long after the first failure was seen.
 */
export const CI_SETTLE_MS = 30 * 60_000;
/** While other checks still run, failures are looked at again this often. */
export const CI_RECHECK_MS = 2 * 60_000;
/** Logs fetched per run (the first failed GitHub Actions jobs). */
const MAX_LOGS = 5;

export interface PrAutomationTiming {
  pollMs: number;
  debounceMs: number;
  idleRecheckMs: number;
  ciSettleMs: number;
  ciRecheckMs: number;
}

/** Timing from the configuration (tests pass their own). */
export function automationTiming(
  config: AppConfig,
  webhookConfigured: boolean,
): PrAutomationTiming {
  return {
    pollMs:
      config.prAutomation.pollIntervalMs ??
      (webhookConfigured ? BACKSTOP_POLL_MS : DEFAULT_POLL_MS),
    debounceMs: WEBHOOK_DEBOUNCE_MS,
    idleRecheckMs: IDLE_RECHECK_MS,
    ciSettleMs: CI_SETTLE_MS,
    ciRecheckMs: CI_RECHECK_MS,
  };
}

export const PR_AUTOMATION_TIMING = Symbol('PR_AUTOMATION_TIMING');

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Separators of shell commands other than `&&` (anything that is not a simple sequence). */
const COMPLEX_SHELL = /[;|\n`$<>(){}\\]|(?<!&)&(?!&)/;

/** What a check found that an autofix run should handle. */
interface Triggers {
  failed: FailedCheck[];
  feedback: ReviewFeedback[];
  headSha: string | null;
}

/**
 * The PR automation of session pull requests (see
 * `PullRequestAutomationDto`): learns about changes from webhook deliveries
 * and polling, reads the current state from GitHub, starts autofix runs,
 * pushes the session branch for Claude during autofix, and closes sessions
 * whose pull requests were merged or closed.
 */
@Injectable()
export class PrAutomationService
  extends WebhookHandler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger('PrAutomation');
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Checks running per pull request, and whether another one is due. */
  private readonly checking = new Map<number, Promise<void>>();
  private readonly again = new Set<number>();
  /** Pull requests whose check found the session busy. */
  private readonly deferred = new Set<number>();
  /** When failed checks were first seen per `pullRequestId:sha`. */
  private readonly failureSeen = new Map<string, number>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private pausedUntil = 0;
  private stopped = false;
  private readonly subscriptions: Subscription[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PR_AUTOMATION_TIMING) private readonly timing: PrAutomationTiming,
    private readonly records: SessionRepository,
    private readonly repositories: RepositoryRepository,
    private readonly sessions: SessionsService,
    private readonly sessionGit: SessionGitService,
    private readonly git: GitService,
    private readonly github: GitHubService,
    private readonly feedback: PullRequestFeedback,
    private readonly notifications: NotificationsService,
    private readonly hooks: SessionAutomationHooks,
    private readonly devServers: DevServers,
  ) {
    super();
  }

  onModuleInit(): void {
    // Turns cut off by a restart are over.
    this.records.clearAutofixRunning();
    this.hooks.autoPush = (sessionId, command, pushes) =>
      this.autoPush(sessionId, command, pushes);
    this.subscriptions.push(
      this.sessionGit.closed$.subscribe((pull) => {
        void this.handleClosed(pull.id).catch((error: unknown) =>
          this.logger.error(
            `Handling the close of ${pull.repositoryName}#${pull.number} failed: ${errorText(error)}`,
          ),
        );
      }),
      this.sessions.updates$.subscribe((session) =>
        this.sessionChanged(session),
      ),
    );
    if (this.timing.pollMs > 0) {
      this.pollTimer = setInterval(() => void this.poll(), this.timing.pollMs);
      this.pollTimer.unref?.();
      const first = setTimeout(() => void this.poll(), 10_000);
      first.unref?.();
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
    if (this.hooks.autoPush) {
      this.hooks.autoPush = null;
    }
  }

  // --- Switches ------------------------------------------------------------

  /**
   * Turns autofix or autoclose of an open pull request on or off, sets
   * its attempt limit, or resets its attempt count.
   */
  update(
    sessionId: string,
    pullRequestId: number,
    request: UpdatePullRequestAutomationRequest,
  ): SessionDto {
    const body = requireObject(request);
    const pull = this.requirePull(sessionId, pullRequestId);
    const flag = (name: 'autofix' | 'autoclose' | 'resetAttempts') => {
      const value = body[name];
      if (value !== undefined && typeof value !== 'boolean') {
        throw new BadRequestException(`${name} must be a boolean`);
      }
      return value as boolean | undefined;
    };
    const autofix = flag('autofix');
    const autoclose = flag('autoclose');
    const reset = flag('resetAttempts');
    const max = body['maxAttempts'];
    if (
      max !== undefined &&
      (typeof max !== 'number' ||
        !Number.isInteger(max) ||
        max < AUTOFIX_MAX_ATTEMPTS_RANGE.min ||
        max > AUTOFIX_MAX_ATTEMPTS_RANGE.max)
    ) {
      throw new BadRequestException(
        `maxAttempts must be a whole number from ${AUTOFIX_MAX_ATTEMPTS_RANGE.min} to ${AUTOFIX_MAX_ATTEMPTS_RANGE.max}`,
      );
    }
    if (pull.state !== 'open' && (autofix === true || autoclose === true)) {
      throw new ConflictException(
        `${pull.repositoryName}#${pull.number} is ${pull.state}; the automation works on open pull requests`,
      );
    }
    const repository = this.repositories.get(pull.repositoryId);
    if (
      (autofix || autoclose) &&
      (!repository || !isGitHubRepository(repository))
    ) {
      throw new ConflictException(
        'The pull request is not on a GitHub repository the app can read',
      );
    }
    const patch: Parameters<SessionRepository['updatePullRequest']>[1] = {};
    if (autofix !== undefined && autofix !== pull.autofix) {
      patch.autofix = autofix;
      if (autofix) {
        // Only reviews from now on start a run; the current checks count.
        patch.autofixReviewsAfter = new Date();
      }
    }
    if (autoclose !== undefined) {
      patch.autoclose = autoclose;
    }
    const attempts = reset ? 0 : pull.autofixAttempts;
    if (reset) {
      patch.autofixAttempts = 0;
    }
    const limit = (max as number | undefined) ?? pull.autofixMaxAttempts;
    if (max !== undefined) {
      patch.autofixMaxAttempts = limit;
    }
    if (reset || attempts < limit) {
      patch.autofixGaveUpAt = null;
    }
    this.records.updatePullRequest(pull.id, patch);
    this.sessions.publishUpdate(sessionId);
    const updated = this.records.pullRequest(pull.id);
    if (updated?.autofix || updated?.autoclose) {
      this.schedule(pull.id, Math.min(1000, this.timing.debounceMs));
    }
    return this.sessions.get(sessionId);
  }

  /**
   * Stops a running autofix run of a session: the turn is stopped and
   * autofix is turned off for its pull request (the attempt still counts).
   */
  async stop(sessionId: string): Promise<SessionDto> {
    const session = this.requireSession(sessionId);
    const running = session.pullRequests.filter((pull) => pull.autofixRunning);
    if (running.length === 0) {
      throw new ConflictException('No autofix run is going on in this session');
    }
    for (const pull of running) {
      this.records.updatePullRequest(pull.id, {
        autofix: false,
        autofixRunning: false,
      });
    }
    try {
      await this.sessions.interrupt(sessionId);
    } catch (error) {
      if (!(error instanceof ConflictException)) {
        throw error;
      }
    }
    this.sessions.recordEvent(sessionId, {
      type: 'notice',
      level: 'info',
      text: `Autofix was stopped and turned off for ${running.map((pull) => `${pull.repositoryName}#${pull.number}`).join(', ')}.`,
    });
    this.sessions.publishUpdate(sessionId);
    return this.sessions.get(sessionId);
  }

  // --- Events --------------------------------------------------------------

  /** A webhook delivery that passed the signature check. */
  onWebhook(event: string, payload: unknown): void {
    const data = (payload ?? {}) as Record<string, unknown>;
    const repository = data['repository'] as { id?: unknown } | undefined;
    if (typeof repository?.id !== 'number') {
      return;
    }
    const numbers = new Set<number>();
    const add = (value: unknown) => {
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        numbers.add(value);
      }
    };
    const pullsOf = (container: unknown) => {
      const pulls = (container as { pull_requests?: unknown } | undefined)
        ?.pull_requests;
      if (Array.isArray(pulls)) {
        pulls
          .slice(0, 50)
          .forEach((pull) => add((pull as { number?: unknown })?.number));
      }
    };
    switch (event) {
      case 'pull_request':
      case 'pull_request_review':
      case 'pull_request_review_comment':
        add((data['pull_request'] as { number?: unknown } | undefined)?.number);
        break;
      case 'check_run':
        pullsOf(data['check_run']);
        break;
      case 'check_suite':
        pullsOf(data['check_suite']);
        break;
    }
    // Statuses (and checks of forks) name no pull request: every pull
    // request of the repository that the automation follows is checked.
    const candidates = this.records
      .pullRequestsOfGitHubRepository(
        repository.id,
        numbers.size > 0 ? [...numbers] : undefined,
      )
      .filter(
        (pull) =>
          pull.state === 'open' &&
          (pull.autofix || pull.autoclose || event === 'pull_request'),
      );
    for (const pull of candidates) {
      this.schedule(pull.id, this.timing.debounceMs);
    }
  }

  /** Checks every open pull request with automation (polling). */
  poll(): Promise<void> {
    if (!this.polling) {
      // Cleared when done (not inside the task: a poll without anything
      // to await would finish before it is stored).
      const polling = this.pollOnce().finally(() => {
        if (this.polling === polling) {
          this.polling = null;
        }
      });
      this.polling = polling;
    }
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    if (!this.github.configured || this.stopped) {
      return;
    }
    if (Date.now() < this.pausedUntil) {
      return;
    }
    for (const pull of this.records.automatedOpenPullRequests()) {
      if (this.stopped || Date.now() < this.pausedUntil) {
        break;
      }
      await this.check(pull.id);
    }
  }

  /** Checks a pull request after `delayMs` (later calls join the timer). */
  schedule(pullRequestId: number, delayMs: number): void {
    if (this.stopped || this.timers.has(pullRequestId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(pullRequestId);
      void this.check(pullRequestId);
    }, delayMs);
    timer.unref?.();
    this.timers.set(pullRequestId, timer);
  }

  /**
   * Reads a pull request from GitHub and acts on it: a merge or close goes
   * to {@link handleClosed} (through `closed$`), failed checks and new
   * reviews may start an autofix run. One check per pull request at a
   * time; a check asked for meanwhile runs afterwards.
   */
  check(pullRequestId: number): Promise<void> {
    const running = this.checking.get(pullRequestId);
    if (running) {
      this.again.add(pullRequestId);
      return running;
    }
    const task = (async () => {
      try {
        do {
          this.again.delete(pullRequestId);
          await this.checkOnce(pullRequestId);
        } while (this.again.has(pullRequestId) && !this.stopped);
      } catch (error) {
        if (error instanceof GitHubRateLimitError) {
          this.pausedUntil = error.resetAt.getTime();
          this.logger.warn(
            `GitHub's rate limit pauses the PR automation until ${error.resetAt.toISOString()}`,
          );
        } else {
          this.logger.warn(
            `Checking pull request ${pullRequestId} failed: ${errorText(error)}`,
          );
        }
      } finally {
        this.checking.delete(pullRequestId);
      }
    })();
    this.checking.set(pullRequestId, task);
    return task;
  }

  private async checkOnce(pullRequestId: number): Promise<void> {
    if (!this.github.configured || this.stopped) {
      return;
    }
    const pull = await this.sessionGit.refreshPullRequest(pullRequestId);
    if (!pull || pull.state !== 'open' || !pull.autofix) {
      return;
    }
    const session = this.records.get(pull.sessionId);
    if (!session) {
      return;
    }
    if (!this.idle(session) || pull.autofixRunning) {
      // Looked at again when the session waits for a message again.
      this.deferred.add(pull.id);
      return;
    }
    this.deferred.delete(pull.id);
    const repository = this.feedbackRepository(pull);
    if (!repository) {
      return;
    }
    const triggers = await this.triggers(pull, repository);
    if (triggers.failed.length === 0 && triggers.feedback.length === 0) {
      return;
    }
    const current = this.records.pullRequest(pull.id);
    if (!current?.autofix || current.state !== 'open') {
      return;
    }
    if (current.autofixAttempts >= current.autofixMaxAttempts) {
      this.giveUp(current, triggers);
      return;
    }
    await this.startRun(current, repository, triggers);
  }

  /** Failed checks of the head commit and new reviews that call for a run. */
  private async triggers(
    pull: PullRequestRecord,
    repository: FeedbackRepository,
  ): Promise<Triggers> {
    const headSha = pull.headSha;
    let failed: FailedCheck[] = [];
    if (headSha && headSha !== pull.autofixCiHandledSha) {
      const checks = await this.feedback.checks(repository, headSha);
      const failures = failedChecks(checks);
      const key = `${pull.id}:${headSha}`;
      if (failures.length > 0) {
        const seen = this.failureSeen.get(key) ?? Date.now();
        this.failureSeen.set(key, seen);
        const pending = pendingChecks(checks);
        if (
          pending.length === 0 ||
          Date.now() - seen >= this.timing.ciSettleMs
        ) {
          failed = failures.map((check) => ({ check, log: null }));
        } else {
          // One run for all checks of the commit: wait for the others.
          this.schedule(pull.id, this.timing.ciRecheckMs);
        }
      }
    }
    const after = pull.autofixReviewsAfter?.getTime() ?? Date.now();
    const candidates = (await this.feedback.reviews(repository, pull.number))
      .filter(
        (item) =>
          new Date(item.createdAt).getTime() > after &&
          item.author !== null &&
          item.authorType !== 'Bot' &&
          !item.author.endsWith('[bot]') &&
          // An approval or an empty review (the container of its comments)
          // asks for nothing by itself.
          !(item.kind === 'review' && item.body.trim() === '') &&
          !(
            item.kind === 'review' &&
            item.state === 'APPROVED' &&
            item.body.trim() === ''
          ),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const feedback: ReviewFeedback[] = [];
    for (const item of candidates) {
      // Only people with write access to the repository start a run.
      if (await this.feedback.canWrite(repository, item.author as string)) {
        feedback.push(item);
      }
    }
    return { failed, feedback, headSha };
  }

  private giveUp(pull: PullRequestRecord, triggers: Triggers): void {
    if (pull.autofixGaveUpAt) {
      return;
    }
    this.records.updatePullRequest(pull.id, { autofixGaveUpAt: new Date() });
    const reason =
      triggers.failed.length > 0
        ? `${triggers.failed.length} check(s) failed again`
        : 'new review feedback';
    const updated = this.records.pullRequest(pull.id) ?? pull;
    this.sessions.recordEvent(pull.sessionId, {
      type: 'notice',
      level: 'warning',
      text: `Autofix reached its limit of ${pull.autofixMaxAttempts} attempt(s) for ${pull.repositoryName}#${pull.number} and starts no further runs (${reason}). Raise the limit or reset the count to let it continue.`,
    });
    this.notifications.notifyAutofixGaveUp(
      pull.sessionId,
      pullRequestDto(updated),
      pull.autofixAttempts,
      reason,
    );
    this.sessions.publishUpdate(pull.sessionId);
  }

  private async startRun(
    pull: PullRequestRecord,
    repository: FeedbackRepository,
    triggers: Triggers,
  ): Promise<void> {
    // Logs of failed GitHub Actions jobs (the job ID is the check run ID).
    let logs = 0;
    for (const failed of triggers.failed) {
      const { check } = failed;
      if (
        check.kind === 'check_run' &&
        check.app === 'github-actions' &&
        check.id !== null &&
        logs < MAX_LOGS
      ) {
        logs++;
        try {
          const tail = await this.feedback.jobLogTail(repository, check.id);
          failed.log = tail === null ? null : logExcerpt(tail);
        } catch (error) {
          this.logger.warn(
            `Could not read the log of job ${check.id}: ${errorText(error)}`,
          );
        }
      }
    }
    // Reading GitHub took a while: the session must still be idle.
    const session = this.records.get(pull.sessionId);
    const current = this.records.pullRequest(pull.id);
    if (
      !session ||
      !current?.autofix ||
      current.state !== 'open' ||
      current.autofixRunning ||
      !this.idle(session)
    ) {
      this.deferred.add(pull.id);
      return;
    }
    const trigger: AutofixTrigger =
      triggers.failed.length > 0 && triggers.feedback.length > 0
        ? 'ci+review'
        : triggers.failed.length > 0
          ? 'ci'
          : 'review';
    const attempt = current.autofixAttempts + 1;
    const directory = session.directories.find(
      (entry) =>
        entry.kind === 'clone' && entry.repositoryId === pull.repositoryId,
    );
    const text = autofixMessage({
      repository: pull.repositoryName,
      number: pull.number,
      trigger,
      attempt,
      maxAttempts: current.autofixMaxAttempts,
      headSha: triggers.headSha,
      branch: directory?.branch ?? pull.headBranch,
    });
    const untrusted = autofixContext({
      repository: pull.repositoryName,
      number: pull.number,
      failed: triggers.failed,
      feedback: triggers.feedback,
    });
    const now = new Date();
    const newest = triggers.feedback.at(-1)?.createdAt;
    this.records.updatePullRequest(pull.id, {
      autofixAttempts: attempt,
      autofixLastRunAt: now,
      autofixLastTrigger: trigger,
      ...(triggers.failed.length > 0
        ? { autofixCiHandledSha: triggers.headSha }
        : {}),
      ...(newest ? { autofixReviewsAfter: new Date(newest) } : {}),
    });
    this.logger.log(
      `Autofix run ${attempt}/${current.autofixMaxAttempts} for ${pull.repositoryName}#${pull.number} (${trigger})`,
    );
    try {
      await this.sessions.sendMessage(pull.sessionId, {
        text,
        origin: 'app',
        untrusted,
      });
    } catch (error) {
      // The run did not start: it does not count.
      this.records.updatePullRequest(pull.id, {
        autofixAttempts: current.autofixAttempts,
        autofixCiHandledSha: current.autofixCiHandledSha,
        autofixReviewsAfter: current.autofixReviewsAfter,
      });
      this.logger.warn(
        `The autofix run for ${pull.repositoryName}#${pull.number} could not start: ${errorText(error)}`,
      );
      this.sessions.publishUpdate(pull.sessionId);
      return;
    }
    // Marked running from here until the turn ends (a very short turn may
    // have ended already).
    const after = this.sessions.get(pull.sessionId);
    if (
      after.status === 'running' ||
      (after.status === 'waiting' && after.waitingFor === 'permission')
    ) {
      this.records.updatePullRequest(pull.id, { autofixRunning: true });
    }
    this.sessions.publishUpdate(pull.sessionId);
  }

  /**
   * A session changed: an autofix run whose turn ended is over, and checks
   * that found the session busy are repeated once it waits for a message.
   */
  private sessionChanged(session: SessionDto): void {
    const turnOver =
      session.status === 'finished' ||
      session.status === 'failed' ||
      (session.status === 'waiting' && session.waitingFor !== 'permission');
    if (!turnOver) {
      return;
    }
    let changed = false;
    for (const pull of session.pullRequests) {
      if (pull.automation.running) {
        this.records.updatePullRequest(pull.id, { autofixRunning: false });
        changed = true;
      }
      if (this.deferred.has(pull.id) && session.waitingFor === 'message') {
        this.deferred.delete(pull.id);
        this.schedule(pull.id, this.timing.idleRecheckMs);
      }
    }
    if (changed) {
      this.sessions.publishUpdate(session.id);
    }
  }

  /** Whether an autofix run may start now: the session waits for a message. */
  private idle(session: SessionRecord): boolean {
    if (session.status !== 'waiting' || session.pendingMessage) {
      return false;
    }
    const dto = this.sessions.get(session.id);
    return (
      dto.status === 'waiting' &&
      dto.waitingFor === 'message' &&
      session.directories.every((directory) => directory.state === 'ready')
    );
  }

  // --- Push during autofix -------------------------------------------------

  /**
   * During autofix Claude may push exactly the session branch of the
   * pull request without asking: no force, no other branch, repository or
   * tag, nothing that deletes. The app does that push itself (as the Push
   * button does: no token reaches the session), so what is pushed does not
   * depend on the command or the clone's configuration. Everything else,
   * and pushes that change workflow files, goes to the user as usual
   * (`null`).
   */
  async autoPush(
    sessionId: string,
    command: string,
    pushes: GitPushAnalysis[],
  ): Promise<AutoPushOutcome | null> {
    const session = this.records.get(sessionId);
    if (!session) {
      return null;
    }
    const autofixClones = session.directories.filter(
      (
        directory,
      ): directory is SessionDirectoryRecord & {
        branch: string;
        repositoryId: string;
      } =>
        directory.kind === 'clone' &&
        directory.state === 'ready' &&
        directory.branch !== null &&
        directory.repositoryId !== null &&
        session.pullRequests.some(
          (pull) =>
            pull.repositoryId === directory.repositoryId &&
            pull.state === 'open' &&
            pull.autofix &&
            pull.headBranch === directory.branch,
        ),
    );
    if (autofixClones.length === 0) {
      return null;
    }
    if (
      pushes.length === 0 ||
      pushes.some(
        (push) =>
          !push.sessionBranchOnly ||
          push.force ||
          push.deletes ||
          push.everything ||
          (push.remote !== null && push.remote !== 'origin'),
      )
    ) {
      return null;
    }
    const paths = simplePushCommand(command);
    if (paths === null) {
      return null;
    }
    let targets = autofixClones;
    if (paths.length > 0) {
      const cwd = workingDirectory(session);
      let location = cwd;
      for (const path of paths) {
        location = isAbsolute(path) ? resolve(path) : resolve(location, path);
      }
      const clone = session.directories.find(
        (directory) =>
          directory.kind === 'clone' &&
          (location === directory.path ||
            location.startsWith(directory.path + sep)),
      );
      const target = autofixClones.find(
        (directory) => directory.path === clone?.path,
      );
      if (!target) {
        return null;
      }
      targets = [target];
    }
    const plans: {
      directory: SessionDirectoryRecord & {
        branch: string;
        repositoryId: string;
      };
      head: string;
    }[] = [];
    for (const directory of targets) {
      const head = await this.git.localBranchCommit(
        directory.path,
        directory.branch,
      );
      const remote = await this.git.remoteBranchCommit(
        directory.path,
        directory.branch,
      );
      if (!head || head === remote) {
        continue;
      }
      // Workflow changes can do anything with the repository's secrets:
      // the user decides about those.
      if (
        await this.git.changesWorkflows(
          directory.path,
          head,
          remote ?? directory.baseCommit,
        )
      ) {
        return null;
      }
      plans.push({ directory, head });
    }
    const done: string[] = [];
    const failed: string[] = [];
    for (const { directory } of plans) {
      try {
        const commit = await this.sessionGit.push(
          sessionId,
          directory.repositoryId,
        );
        done.push(
          `${directory.branch} of ${directory.repositoryName} at ${commit.slice(0, 7)}`,
        );
      } catch (error) {
        failed.push(
          `${directory.branch} of ${directory.repositoryName}: ${errorText(error)}`,
        );
      }
    }
    const names = targets
      .map((directory) => directory.repositoryName)
      .join(', ');
    if (plans.length === 0) {
      return {
        message: `Not run: during autofix the app pushes the session branch itself, and GitHub already has the latest commit of the session branch of ${names}. Nothing was pushed; commit your changes first if you meant to push them.`,
        notice: `Autofix: nothing to push for ${names}.`,
      };
    }
    const lines = [
      'Not run as written: during autofix the app pushes the session branch itself (without force).',
      done.length > 0
        ? `Pushed: ${done.join('; ')}. The push is complete; do not push again.`
        : null,
      failed.length > 0 ? `Failed: ${failed.join('; ')}.` : null,
    ].filter(Boolean);
    return {
      message: lines.join(' '),
      notice: [
        done.length > 0
          ? `Autofix pushed ${done.join('; ')} without asking.`
          : null,
        failed.length > 0 ? `Autofix push failed: ${failed.join('; ')}.` : null,
      ]
        .filter(Boolean)
        .join(' '),
    };
  }

  // --- Merge and close -----------------------------------------------------

  /**
   * A pull request was read as merged or closed: notifies once, and with
   * autoclose ends the session and removes its clones when it has no open
   * pull request left.
   */
  async handleClosed(pullRequestId: number): Promise<void> {
    const pull = this.records.pullRequest(pullRequestId);
    if (!pull || pull.state === 'open' || pull.closeHandledAt) {
      return;
    }
    this.records.updatePullRequest(pull.id, {
      closeHandledAt: new Date(),
      autofixRunning: false,
    });
    const session = this.records.get(pull.sessionId);
    if (!session) {
      return;
    }
    const open = session.pullRequests.filter((entry) => entry.state === 'open');
    const autoclose =
      !session.autoclosedAt &&
      open.length === 0 &&
      session.pullRequests.some((entry) => entry.autoclose);
    let note: string | null = null;
    if (autoclose) {
      const kept = await this.autoclose(session, pull);
      note =
        kept.length > 0
          ? `Session ended; kept the clone of ${kept.join(', ')}: it has work that is not on GitHub`
          : 'Session ended and its clones removed';
    } else if (pull.autoclose && open.length > 0) {
      this.sessions.recordEvent(session.id, {
        type: 'notice',
        level: 'info',
        text: `${pull.repositoryName}#${pull.number} was ${pull.state}. Autoclose waits until ${open.map((entry) => `${entry.repositoryName}#${entry.number}`).join(', ')} ${open.length === 1 ? 'is' : 'are'} merged or closed too.`,
      });
    }
    this.notifications.notifyPullRequestClosed(
      session.id,
      pullRequestDto(this.records.pullRequest(pull.id) ?? pull),
      note,
    );
    this.sessions.publishUpdate(session.id);
  }

  /**
   * Ends the session, stops its dev servers and removes its clones, except
   * clones with work that is not on GitHub. Returns the repositories whose
   * clones were kept.
   */
  private async autoclose(
    session: SessionRecord,
    pull: PullRequestRecord,
  ): Promise<string[]> {
    this.records.update(session.id, { autoclosedAt: new Date() });
    if (session.status !== 'finished') {
      try {
        await this.sessions.end(session.id);
      } catch (error) {
        this.logger.warn(
          `Autoclose could not end ${session.id}: ${errorText(error)}`,
        );
      }
    }
    try {
      await this.devServers.stopSession(session.id);
    } catch (error) {
      this.logger.warn(
        `Stopping the dev servers of ${session.id} failed: ${errorText(error)}`,
      );
    }
    const kept: string[] = [];
    const details: string[] = [];
    for (const directory of session.directories) {
      if (directory.kind !== 'clone' || directory.state !== 'ready') {
        continue;
      }
      const name = directory.repositoryName ?? directory.path;
      let loss: Omit<
        CloneLossReport,
        'repositoryId' | 'repository' | 'path' | 'clean'
      >;
      try {
        loss = await this.git.cloneLoss(directory.path, {
          knownRemoteCommits: this.remoteHeads(session, directory),
        });
      } catch (error) {
        // Unknown state: keep it.
        this.logger.warn(
          `Could not check the clone ${directory.path}: ${errorText(error)}`,
        );
        kept.push(name);
        details.push(`${name}: could not be checked (${errorText(error)})`);
        continue;
      }
      if (lossIsEmpty(loss)) {
        await this.removeClone(session, directory);
      } else {
        kept.push(name);
        details.push(`${name}: ${describeLoss(loss)}`);
      }
    }
    await this.removeEmptyParents(session);
    const what = `${pull.repositoryName}#${pull.number} was ${pull.state}`;
    this.sessions.recordEvent(session.id, {
      type: 'notice',
      level: kept.length > 0 ? 'warning' : 'info',
      text:
        kept.length > 0
          ? `${what}. Autoclose ended the session and removed its clones, but kept ${kept.length === 1 ? 'one' : kept.length} with work that is not on GitHub (${details.join('; ')}). Delete ${kept.length === 1 ? 'it' : 'them'} in the session view when you no longer need ${kept.length === 1 ? 'it' : 'them'}.`
          : `${what}. Autoclose ended the session and removed its clones.`,
    });
    return kept;
  }

  // --- Kept clones ---------------------------------------------------------

  /** What deleting a session clone would lose. */
  async cloneLoss(
    sessionId: string,
    repositoryId: string,
  ): Promise<CloneLossReport> {
    const session = this.requireSession(sessionId);
    const directory = this.requireClone(session, repositoryId);
    const loss = await this.git.cloneLoss(directory.path, {
      knownRemoteCommits: this.remoteHeads(session, directory),
    });
    return {
      repositoryId,
      repository: directory.repositoryName ?? '',
      path: directory.path,
      ...loss,
      clean: lossIsEmpty(loss),
    };
  }

  /**
   * Deletes a clone of an ended session after the user confirmed what
   * would be lost.
   */
  async discardClone(
    sessionId: string,
    repositoryId: string,
    request: { confirm?: unknown },
  ): Promise<SessionDto> {
    const body = requireObject(request);
    if (body['confirm'] !== true) {
      throw new BadRequestException(
        'Deleting a clone needs confirm: true (after showing what would be lost)',
      );
    }
    const session = this.requireSession(sessionId);
    if (session.status !== 'finished') {
      throw new ConflictException('End the session before deleting its clones');
    }
    const directory = this.requireClone(session, repositoryId);
    await this.removeClone(session, directory);
    await this.removeEmptyParents(session);
    this.sessions.recordEvent(sessionId, {
      type: 'notice',
      level: 'info',
      text: `The clone of ${directory.repositoryName} was deleted.`,
    });
    this.sessions.publishUpdate(sessionId);
    return this.sessions.get(sessionId);
  }

  // -------------------------------------------------------------------------

  private async removeClone(
    session: SessionRecord,
    directory: SessionDirectoryRecord,
  ): Promise<void> {
    await this.git.removeSessionClone(directory.path);
    this.records.updateDirectory(session.id, directory.position, {
      state: 'removed',
    });
  }

  /** Removes `sessions/<slug>/<owner>` and `sessions/<slug>` once empty. */
  private async removeEmptyParents(session: SessionRecord): Promise<void> {
    if (!session.slug) {
      return;
    }
    const root = join(this.config.sessionsDir, session.slug);
    const owners = new Set(
      session.directories
        .filter((directory) => directory.kind === 'clone')
        .map((directory) => dirname(directory.path))
        .filter((path) => !relative(root, path).startsWith('..')),
    );
    for (const path of [...owners, root]) {
      try {
        if ((await readdir(path)).length === 0) {
          await rmdir(path);
        }
      } catch {
        // gone already, or not empty
      }
    }
  }

  /** Head commits GitHub has for the clone's pull requests. */
  private remoteHeads(
    session: SessionRecord,
    directory: SessionDirectoryRecord,
  ): string[] {
    return session.pullRequests
      .filter((pull) => pull.repositoryId === directory.repositoryId)
      .flatMap((pull) => (pull.headSha ? [pull.headSha] : []));
  }

  private feedbackRepository(
    pull: PullRequestRecord,
  ): FeedbackRepository | null {
    const repository = this.repositories.get(pull.repositoryId);
    if (!repository || !isGitHubRepository(repository)) {
      return null;
    }
    return {
      installationId: repository.githubInstallationId,
      githubRepositoryId: repository.githubRepositoryId,
      fullName: `${repository.owner}/${repository.name}`,
    };
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.records.get(sessionId);
    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    return session;
  }

  private requirePull(
    sessionId: string,
    pullRequestId: number,
  ): PullRequestRecord {
    const pull = this.requireSession(sessionId).pullRequests.find(
      (entry) => entry.id === pullRequestId,
    );
    if (!pull) {
      throw new NotFoundException(
        `Pull request ${pullRequestId} is not one of session ${sessionId}`,
      );
    }
    return pull;
  }

  private requireClone(
    session: SessionRecord,
    repositoryId: string,
  ): SessionDirectoryRecord {
    const directory = session.directories.find(
      (entry) => entry.kind === 'clone' && entry.repositoryId === repositoryId,
    );
    if (!directory) {
      throw new NotFoundException(
        `The session has no clone of repository ${repositoryId}`,
      );
    }
    if (directory.state !== 'ready') {
      throw new ConflictException(
        `The clone of ${directory.repositoryName} is ${directory.state}`,
      );
    }
    return directory;
  }
}

function lossIsEmpty(loss: {
  uncommittedCount: number;
  unpushedCount: number;
  stashes: number;
}): boolean {
  return (
    loss.uncommittedCount === 0 &&
    loss.unpushedCount === 0 &&
    loss.stashes === 0
  );
}

function describeLoss(loss: {
  uncommittedCount: number;
  unpushedCount: number;
  stashes: number;
}): string {
  return [
    loss.uncommittedCount > 0
      ? `${loss.uncommittedCount} uncommitted file(s)`
      : null,
    loss.unpushedCount > 0 ? `${loss.unpushedCount} unpushed commit(s)` : null,
    loss.stashes > 0
      ? `${loss.stashes} stash entr${loss.stashes === 1 ? 'y' : 'ies'}`
      : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * The directories a command changes into before its `git push`, if it is
 * nothing but `git push` (optionally after `cd <dir> &&` or with
 * `git -C <dir>`); `null` for anything else (other commands, pipes,
 * substitutions, redirections), which then needs the user's approval.
 */
export function simplePushCommand(command: string): string[] | null {
  if (COMPLEX_SHELL.test(command)) {
    return null;
  }
  const paths: string[] = [];
  let pushes = 0;
  for (const part of command.split('&&')) {
    const words = [...part.trim().matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
      (match) => match[1] ?? match[2] ?? match[3],
    );
    if (words.length === 0) {
      return null;
    }
    if (words[0] === 'cd') {
      if (words.length !== 2) {
        return null;
      }
      paths.push(words[1]);
      continue;
    }
    if (words[0] !== 'git') {
      return null;
    }
    let index = 1;
    while (index < words.length && words[index].startsWith('-')) {
      if (words[index] === '-C' && index + 1 < words.length) {
        paths.push(words[index + 1]);
        index += 2;
      } else {
        // Other git options (-c config, --git-dir, ...) are not accepted.
        return null;
      }
    }
    if (words[index] !== 'push') {
      return null;
    }
    pushes++;
  }
  return pushes === 1 ? paths : null;
}
