import { readdir, rmdir } from 'node:fs/promises';
import {
  cloneRule,
  IncompleteRemovalError,
  WorkspaceEntries,
} from '../workspaces/workspace-entries';
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
  Optional,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import {
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
import {
  GitHubApiError,
  GitHubRateLimitError,
  GitHubUnavailableError,
} from '../github/github-errors';
import { GitHubService, type MergeMethod } from '../github/github.service';
import { NotificationsService } from '../notifications/notifications.service';
import { isGitHubRepository } from '../repositories/repository-credentials';
import { RepositoryRepository } from '../repositories/repository.repository';
import { pullRequestDto } from '../sessions/pull-request-dto';
import {
  SessionAutomationHooks,
  type AutofixCommandOutcome,
  type PullRequestAutomationSwitches,
} from '../sessions/session-automation-hooks';
import { parseAutofixGitCommand } from './autofix-git';
import { PullRequestChecksService } from './pull-request-checks.service';
import { SessionGitService } from '../sessions/session-git.service';
import {
  cloneOf,
  cloneOfPull,
  retiresAfterPullRequest,
} from '../sessions/session-clones';
import {
  isActiveDirectory,
  SessionRepository,
  workingDirectoryOf,
  type PullRequestRecord,
  type SessionDirectoryRecord,
  type SessionRecord,
} from '../sessions/session.repository';
import { SessionsService } from '../sessions/sessions.service';
import {
  autofixContext,
  autofixMessage,
  readyMessage,
  type AutomergeNote,
  failedChecks,
  logExcerpt,
  pendingChecks,
  type FailedCheck,
} from './autofix-context';
import {
  PullRequestFeedback,
  type CheckResult,
  type FeedbackRepository,
  type ReviewFeedback,
  type ReviewThread,
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
/**
 * GitHub computes whether a pull request merges cleanly only when asked
 * (and sends no event when it is done): looked at again this soon, at most
 * {@link MAX_MERGEABLE_RECHECKS} times per head commit.
 */
export const MERGEABLE_RECHECK_MS = 10_000;
const MAX_MERGEABLE_RECHECKS = 3;
/** Logs fetched per run (the first failed GitHub Actions jobs). */
const MAX_LOGS = 5;

export interface PrAutomationTiming {
  pollMs: number;
  debounceMs: number;
  idleRecheckMs: number;
  ciSettleMs: number;
  ciRecheckMs: number;
  /** Default {@link MERGEABLE_RECHECK_MS}. */
  mergeableRecheckMs?: number;
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

/** Notice text for clones whose deleting left files (see `removeClone`). */
function leftoversNote(errors: string[]): string {
  return `Files were left over (${errors.join('; ')}); remove them under Workspace cleanup.`;
}

/** Characters of Claude's question kept with a hold. */
const MAX_HOLD_REASON = 1000;

/**
 * Refusals of a merge that may pass by themselves (the base branch moved,
 * GitHub still computing mergeability, GitHub unreachable): retried this
 * often per head commit, every {@link PrAutomationTiming.ciRecheckMs},
 * before they count as refused.
 */
export const MAX_MERGE_RETRIES = 3;

function transientMergeFailure(error: unknown): boolean {
  return (
    error instanceof GitHubUnavailableError ||
    (error instanceof GitHubApiError &&
      (error.githubStatus === 409 ||
        (error.githubStatus === 405 &&
          /not mergeable|was modified|try the merge again/i.test(
            error.message,
          ))))
  );
}

/** What an automerge attempt came to. */
type AutomergeOutcome =
  | { kind: 'merged' }
  /** Added to the base branch's merge queue (or in it already). */
  | { kind: 'queued' }
  /** Unresolved review threads (all of them; `counting`: by those who count). */
  | { kind: 'threads'; count: number; counting: ReviewThread[] }
  /** Held, a draft, refused before, or the session got busy. */
  | { kind: 'blocked' };

/** What a check found that an autofix run should handle. */
interface Triggers {
  failed: FailedCheck[];
  /** New reviews and comments that may ask for changes. */
  feedback: ReviewFeedback[];
  /** New approvals with text: context of a run, never its cause. */
  approvals: ReviewFeedback[];
  /** The head commit is ready to merge, see `passed` (not told yet). */
  ready: boolean;
  /**
   * The head commit passed all checks and is approved; with automerge,
   * approval is not needed (the owner's decision): at least one check
   * reported and nobody who counts requests changes (told or not).
   */
  passed: boolean;
  /** Someone who counts approved the head commit. */
  approved: boolean;
  /** GitHub reports at least one check for the head commit. */
  checked: boolean;
  headSha: string | null;
  /**
   * GitHub reports merge conflicts with the base branch for the head
   * commit, and no run was started for them yet.
   */
  conflict: boolean;
  /** GitHub reports merge conflicts (run started for them or not). */
  conflicting: boolean;
  /**
   * The merge queue removed the pull request without merging its head
   * commit: GitHub's reason, and the failed checks of the commit the queue
   * tested (its merge group), when known.
   */
  dequeued?: { reason: string; failed: FailedCheck[] } | null;
}

/**
 * GitHub's reason for removing a pull request from a merge queue, readable
 * (`CI_FAILURE` → "ci failure"); anything but such a name is "unknown
 * reason", so that only plain words reach the app's own texts.
 */
export function queueReason(reason: string | null | undefined): string {
  return reason && /^[A-Z][A-Z_]{0,40}$/.test(reason) && reason !== 'UNKNOWN'
    ? reason.toLowerCase().replace(/_/g, ' ')
    : 'unknown reason';
}

/**
 * GitHub's reason for the owner's eyes (history, notifications): plain
 * words for an enum name, else GitHub's text, on one line and shortened.
 * Never for texts that go to Claude (see {@link queueReason}).
 */
export function ownerQueueReason(reason: string | null | undefined): string {
  const plain = queueReason(reason);
  if (plain !== 'unknown reason' || !reason || reason === 'UNKNOWN') {
    return plain;
  }
  const line = reason.replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line || plain;
}

/**
 * One removal from a merge queue: the pull request, the commit and when it
 * was added (a later enqueue of the same commit is another removal).
 */
function removalKey(pull: PullRequestRecord): string {
  return `${pull.id}:${pull.mergeQueueRemovedSha}:${pull.mergeQueuedAt?.getTime() ?? ''}`;
}

/** Conclusions (and status states) of checks that passed. */
const PASSED_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * Whether the session's turn is over: finished, failed, or waiting for
 * anything but an approval.
 */
function turnIsOver(session: SessionDto): boolean {
  return (
    session.status === 'finished' ||
    session.status === 'failed' ||
    (session.status === 'waiting' && session.waitingFor !== 'permission')
  );
}

/** Whether every check is completed and passed (none: `true`). */
function allPassed(checks: CheckResult[]): boolean {
  return checks.every(
    (check) =>
      check.status === 'completed' &&
      check.conclusion !== null &&
      PASSED_CONCLUSIONS.has(check.conclusion),
  );
}

/** Review states that decide whether a reviewer approves. */
const DECIDING_REVIEW_STATES = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'DISMISSED',
]);

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
  /**
   * Queue removals already noted in the history (see {@link removalKey}),
   * until they are handled.
   */
  private readonly queueRemovalsTold = new Set<string>();
  /**
   * Pull requests per session whose CI settled while Claude said it goes on
   * by itself, until it is woken (see {@link wakeAfterCi}).
   */
  private readonly ciSettled = new Map<string, Set<number>>();
  /** Pull requests closed while a turn ran: their close wakes nobody. */
  private readonly closedInTurn = new Set<number>();
  /** Whether the first poll looked for closes left unhandled. */
  private closesSwept = false;
  /**
   * Since when failed checks or new feedback per `pullRequestId:sha` wait
   * for the commit's other checks to finish.
   */
  private readonly waitingSince = new Map<string, number>();
  /** Merges retried per `pullRequestId:sha` after a passing refusal. */
  private readonly mergeRetries = new Map<string, number>();
  /** Looks again after GitHub had not computed mergeability, per head commit. */
  private readonly mergeableRechecks = new Map<string, number>();
  /** Bots whose reviews and comments count (lower case). */
  private readonly trustedBots: ReadonlySet<string>;
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
    @Optional() private readonly checksView?: PullRequestChecksService,
  ) {
    super();
    this.trustedBots = new Set(
      config.prAutomation.trustedBots.map((login) => login.toLowerCase()),
    );
  }

  onModuleInit(): void {
    // Turns cut off by a restart are over.
    this.records.clearAutofixRunning();
    this.hooks.autofixCommand = (sessionId, command, pushes) =>
      this.autofixCommand(sessionId, command, pushes);
    this.hooks.holdAutomerge = (sessionId, question) =>
      this.holdAutomerge(sessionId, question);
    this.hooks.ownerMessage = (sessionId) => this.ownerMessage(sessionId);
    this.hooks.setAutomation = (sessionId, repositoryId, number, switches) =>
      this.setAutomationByClaude(sessionId, repositoryId, number, switches);
    this.hooks.mayMergeUnasked = (sessionId, repositoryId, number) =>
      this.mayMergeUnasked(sessionId, repositoryId, number);
    this.hooks.continueAutofix = (sessionId, pullRequestIds, send) =>
      this.continueAutofix(sessionId, pullRequestIds, send);
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
    if (this.checksView) {
      // CI settled while the session waited for it: look now, so that a
      // run or ready message follows right away. A check that runs may
      // have read the checks before they settled: it checks again before
      // it ends the wait.
      this.subscriptions.push(
        this.checksView.settled$.subscribe((pullRequestId) => {
          if (this.checking.has(pullRequestId)) {
            this.again.add(pullRequestId);
          } else {
            this.schedule(pullRequestId, this.timing.idleRecheckMs);
          }
        }),
      );
    }
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
    this.hooks.autofixCommand = null;
    this.hooks.holdAutomerge = null;
    this.hooks.ownerMessage = null;
    this.hooks.setAutomation = null;
    this.hooks.mayMergeUnasked = null;
    this.hooks.continueAutofix = null;
  }

  // --- Switches ------------------------------------------------------------

  /**
   * Turns autofix, autoclose or automerge of an open pull request on or
   * off. Automerge
   * needs autofix: turning it on turns autofix on, turning autofix off
   * turns it off.
   */
  update(
    sessionId: string,
    pullRequestId: number,
    request: UpdatePullRequestAutomationRequest,
  ): SessionDto {
    const body = requireObject(request);
    const pull = this.requirePull(sessionId, pullRequestId);
    const flag = (name: 'autofix' | 'autoclose' | 'automerge') => {
      const value = body[name];
      if (value !== undefined && typeof value !== 'boolean') {
        throw new BadRequestException(`${name} must be a boolean`);
      }
      return value as boolean | undefined;
    };
    const autofix = flag('autofix');
    const autoclose = flag('autoclose');
    const automerge = flag('automerge');
    if (automerge === true && autofix === false) {
      throw new BadRequestException('Automerge needs autofix');
    }
    if (
      pull.state !== 'open' &&
      (autofix === true || autoclose === true || automerge === true)
    ) {
      throw new ConflictException(
        `${pull.repositoryName}#${pull.number} is ${pull.state}; the automation works on open pull requests`,
      );
    }
    const repository = this.repositories.get(pull.repositoryId);
    if (
      (autofix || autoclose || automerge) &&
      (!repository || !isGitHubRepository(repository))
    ) {
      throw new ConflictException(
        'The pull request is not on a GitHub repository the app can read',
      );
    }
    const patch: Parameters<SessionRepository['updatePullRequest']>[1] = {};
    // Automerge works through autofix (it fixes what reviewers find).
    const wantsAutofix = automerge === true ? true : autofix;
    if (wantsAutofix !== undefined && wantsAutofix !== pull.autofix) {
      patch.autofix = wantsAutofix;
      if (wantsAutofix) {
        // Only reviews from now on start a run; the current checks count.
        patch.autofixReviewsAfter = new Date();
      }
    }
    const wantsAutomerge = autofix === false ? false : automerge;
    if (wantsAutomerge !== undefined) {
      patch.automerge = wantsAutomerge;
      // Turning it on (again) lifts a hold and retries a refused merge.
      patch.automergeHeldAt = null;
      patch.automergeHoldReason = null;
      patch.automergeFailedSha = null;
      patch.automergeFailure = null;
      patch.automergeWaiting = null;
    }
    if (autoclose !== undefined) {
      patch.autoclose = autoclose;
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
   * Claude asked for the owner's decision (tool `request_owner_decision`):
   * automerge of the session's open pull requests pauses until the owner's
   * next message, and the owner is notified. Returns what Claude is told.
   */
  holdAutomerge(sessionId: string, question: string): string {
    const session = this.records.get(sessionId);
    const pulls =
      session?.pullRequests.filter(
        (pull) => pull.state === 'open' && pull.automerge,
      ) ?? [];
    if (pulls.length === 0) {
      return 'Automerge is not on for any open pull request of this session, so nothing was paused. Ask the user your question in your reply.';
    }
    const reason =
      question.length > MAX_HOLD_REASON
        ? `${question.slice(0, MAX_HOLD_REASON)}…`
        : question;
    const now = new Date();
    for (const pull of pulls) {
      this.records.updatePullRequest(pull.id, {
        automergeHeldAt: now,
        automergeHoldReason: reason,
        automergeWaiting: null,
      });
    }
    const names = pulls
      .map((pull) => `${pull.repositoryName}#${pull.number}`)
      .join(', ');
    this.sessions.recordEvent(sessionId, {
      type: 'notice',
      level: 'warning',
      text: `Automerge of ${names} is paused: Claude asks for your decision. Your next message lets it continue.`,
    });
    for (const pull of pulls) {
      this.notifications.notifyAutomerge(
        sessionId,
        pullRequestDto(this.records.pullRequest(pull.id) ?? pull),
        'held',
        reason,
      );
    }
    this.sessions.publishUpdate(sessionId);
    this.logger.log(`Automerge of ${names} waits for the owner's decision`);
    return `Automerge of ${names} is paused until the user's next message, and the user was notified. Ask your question in your reply now and end your turn.`;
  }

  /**
   * Claude switches the automation of one of the session's pull requests
   * (tool `set_pr_automation`, after the approval the permission mode asks
   * for), as the switches of the session view do. Switches already as asked
   * are left alone (turning automerge on again would lift a hold and retry
   * a refused merge). Turning on is refused during an Autofix run (it acts
   * on GitHub's untrusted content, which must not turn on fixing or
   * merging), and automerge while the session waits for the owner's
   * decision (`request_owner_decision`). Returns what Claude is told.
   */
  setAutomationByClaude(
    sessionId: string,
    repositoryId: string,
    number: number,
    switches: PullRequestAutomationSwitches,
  ): string {
    const session = this.requireSession(sessionId);
    const pull = session.pullRequests.find(
      (entry) => entry.repositoryId === repositoryId && entry.number === number,
    );
    if (!pull) {
      throw new NotFoundException(
        `#${number} is not a pull request of this session; create it with create_pull_request first`,
      );
    }
    const name = `${pull.repositoryName}#${pull.number}`;
    const names = ['autofix', 'automerge', 'autoclose'] as const;
    if (names.every((key) => switches[key] === undefined)) {
      throw new BadRequestException(
        'Name at least one of autofix, automerge, autoclose',
      );
    }
    if (switches.automerge === true && switches.autofix === false) {
      throw new BadRequestException('Automerge needs autofix');
    }
    const changes: PullRequestAutomationSwitches = {};
    for (const key of names) {
      const value = switches[key];
      if (value !== undefined && value !== pull[key]) {
        changes[key] = value;
      }
    }
    const turnsOn = names.some((key) => changes[key] === true);
    if (
      turnsOn &&
      (this.sessions.inAutofixRun(sessionId) ||
        session.pullRequests.some((entry) => entry.autofixRunning))
    ) {
      throw new ConflictException(
        'During an Autofix run switches can only be turned off (only false values); ask the user to turn them on',
      );
    }
    if (
      changes.automerge === true &&
      session.pullRequests.some((entry) => entry.automergeHeldAt !== null)
    ) {
      throw new ConflictException(
        "Automerge waits for the user's decision (request_owner_decision); only the user's next message lifts that",
      );
    }
    const state = (on: boolean) => (on ? 'on' : 'off');
    const describe = (current: PullRequestRecord) =>
      names.map((key) => `${key} ${state(current[key])}`).join(', ');
    if (Object.keys(changes).length === 0) {
      return `Nothing changed. ${name}: ${describe(pull)}.`;
    }
    this.update(sessionId, pull.id, changes);
    if (pull.automergeHeldAt !== null) {
      // Turning automerge off must not end the wait for the owner (only
      // their next message does): a hold kept on would refuse turning it
      // on again.
      this.records.updatePullRequest(pull.id, {
        automergeHeldAt: pull.automergeHeldAt,
        automergeHoldReason: pull.automergeHoldReason,
      });
      // `update` published the session without the hold.
      this.sessions.publishUpdate(sessionId);
    }
    const updated = this.records.pullRequest(pull.id) ?? pull;
    this.sessions.recordEvent(sessionId, {
      type: 'notice',
      level: 'info',
      text: `Claude switched the automation of ${name}: ${describe(updated)}.`,
    });
    this.logger.log(`Claude switched the automation of ${name}`);
    return `${name}: ${describe(updated)}.`;
  }

  /** The owner sent a message: automerge waits no longer for them. */
  ownerMessage(sessionId: string): void {
    const session = this.records.get(sessionId);
    const held =
      session?.pullRequests.filter((pull) => pull.automergeHeldAt !== null) ??
      [];
    if (held.length === 0) {
      return;
    }
    for (const pull of held) {
      this.records.updatePullRequest(pull.id, {
        automergeHeldAt: null,
        automergeHoldReason: null,
      });
    }
    this.sessions.recordEvent(sessionId, {
      type: 'notice',
      level: 'info',
      text: `Automerge of ${held.map((pull) => `${pull.repositoryName}#${pull.number}`).join(', ')} continues: you answered.`,
    });
    this.sessions.publishUpdate(sessionId);
    for (const pull of held) {
      if (pull.state === 'open' && pull.automerge) {
        // The session is busy with the message now: the check waits.
        this.schedule(pull.id, this.timing.idleRecheckMs);
      }
    }
  }

  /**
   * Continues an Autofix run the usage limit stopped (see
   * `SessionAutomationHooks.continueAutofix`): only for pull requests that
   * are still open with autofix on.
   */
  private async continueAutofix(
    sessionId: string,
    pullRequestIds: number[],
    send: () => Promise<void>,
  ): Promise<boolean> {
    const pulls = this.requireSession(sessionId).pullRequests.filter(
      (pull) =>
        pullRequestIds.includes(pull.id) &&
        pull.state === 'open' &&
        pull.autofix,
    );
    if (pulls.length === 0) {
      return false;
    }
    await send();
    // Going on again until the turn ends, as after `runAutofix`.
    const after = this.sessions.get(sessionId);
    if (
      after.status === 'running' ||
      (after.status === 'waiting' && after.waitingFor === 'permission')
    ) {
      for (const pull of pulls) {
        this.records.updatePullRequest(pull.id, { autofixRunning: true });
      }
    }
    this.sessions.publishUpdate(sessionId);
    return true;
  }

  /**
   * Stops a running autofix run of a session: the turn is stopped and
   * autofix is turned off for its pull request.
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
        // Automerge works only with autofix.
        automerge: false,
        automergeHeldAt: null,
        automergeHoldReason: null,
        automergeWaiting: null,
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
      text: `Autofix was stopped and turned off for ${running.map((pull) => `${pull.repositoryName}#${pull.number}`).join(', ')}${running.some((pull) => pull.automerge) ? ', and automerge with it' : ''}.`,
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
      case 'pull_request_review_thread':
        add((data['pull_request'] as { number?: unknown } | undefined)?.number);
        break;
      case 'issue_comment': {
        // Comments of pull requests (issues are not followed).
        const issue = data['issue'] as
          | { number?: unknown; pull_request?: unknown }
          | undefined;
        if (!issue?.pull_request) {
          return;
        }
        add(issue.number);
        break;
      }
      case 'check_run':
        pullsOf(data['check_run']);
        break;
      case 'check_suite':
        pullsOf(data['check_suite']);
        break;
    }
    if (
      event === 'check_run' ||
      event === 'check_suite' ||
      event === 'status'
    ) {
      // The view shows the checks of every open pull request.
      this.checksView?.onDelivery(
        repository.id,
        numbers.size > 0 ? [...numbers] : undefined,
      );
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
          (pull.autofix ||
            pull.autoclose ||
            pull.mergeQueuedSha !== null ||
            event === 'pull_request'),
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
    if (!this.closesSwept) {
      this.closesSwept = true;
      for (const session of this.records.list()) {
        if (session.status !== 'running' && session.status !== 'preparing') {
          this.handleUnhandledCloses(session.id);
        }
      }
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
        // Settled checks were looked at: the session no longer waits for
        // them (a run started is a turn by now).
        const pull = this.records.pullRequest(pullRequestId);
        if (pull) {
          if (
            this.sessions.ciWaitPhase(pull.sessionId, pull.id) === 'settling'
          ) {
            // Noted before the wait ends: its end may publish the session,
            // and the wake then has to name this pull request too.
            const told = this.ciSettled.get(pull.sessionId) ?? new Set();
            told.add(pull.id);
            this.ciSettled.set(pull.sessionId, told);
          }
          this.sessions.endCiSettling(pull.sessionId, pull.id);
          if (this.ciSettled.has(pull.sessionId)) {
            // Nothing took the session's turn over (a run, a merge):
            // Claude may wait for exactly this CI.
            this.wakeAfterCiLater(pull.sessionId);
          }
        }
      }
    })();
    this.checking.set(pullRequestId, task);
    return task;
  }

  private async checkOnce(pullRequestId: number): Promise<void> {
    if (!this.github.configured || this.stopped) {
      return;
    }
    const refreshed = await this.sessionGit.refreshPullRequest(pullRequestId);
    if (!refreshed || refreshed.state !== 'open') {
      return;
    }
    if (refreshed.mergeQueueRemovedSha && !refreshed.autofix) {
      // Without autofix the owner (and Claude, if it waits) is told.
      await this.queueRemovalWithoutAutofix(refreshed);
      return;
    }
    const pull = this.queueLeftByPush(refreshed);
    if (!pull.autofix) {
      return;
    }
    if (pull.mergeConflict === null && pull.headSha) {
      // Asking made GitHub compute it: look again soon.
      const key = `${pull.id}:${pull.headSha}`;
      const count = this.mergeableRechecks.get(key) ?? 0;
      if (count < MAX_MERGEABLE_RECHECKS) {
        this.mergeableRechecks.set(key, count + 1);
        this.schedule(
          pull.id,
          this.timing.mergeableRecheckMs ?? MERGEABLE_RECHECK_MS,
        );
      }
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
    const queued =
      pull.mergeQueuedSha !== null && pull.mergeQueuedSha === triggers.headSha;
    if (queued) {
      // In the merge queue: GitHub merges it, nothing to tell or merge.
      triggers.ready = false;
    }
    let merge: AutomergeOutcome | null = null;
    if (triggers.dequeued && triggers.headSha) {
      // A run for the removal (failed checks and feedback come along);
      // automerge does not add this head commit again.
      this.noteQueueRemoval(pull, triggers.headSha, triggers.dequeued.reason);
    } else if (pull.automerge && queued) {
      this.setWaiting(pull.id, null);
    } else if (pull.automerge) {
      if (triggers.conflicting) {
        // GitHub would refuse the merge: the branch is rebased first.
        this.setWaiting(
          pull.id,
          triggers.passed ? `merge conflicts with ${pull.baseBranch}` : null,
        );
      } else if (
        triggers.passed &&
        triggers.headSha &&
        triggers.failed.length === 0 &&
        triggers.feedback.length === 0
      ) {
        if (!triggers.checked) {
          // "CI green" needs CI: right after a push GitHub may not list
          // the new commit's checks yet.
          this.setWaiting(pull.id, 'no checks reported for the head commit');
        } else {
          merge = await this.automerge(pull, repository, triggers.headSha);
          if (merge.kind === 'merged' || merge.kind === 'queued') {
            return;
          }
        }
      } else {
        // Not ready, or there is something to fix first.
        this.setWaiting(pull.id, null);
      }
    }
    const idleRound =
      triggers.failed.length === 0 &&
      triggers.feedback.length === 0 &&
      !triggers.conflict &&
      !triggers.dequeued &&
      !triggers.ready;
    if (
      merge?.kind === 'threads' &&
      triggers.headSha &&
      (idleRound || merge.counting.length === 0)
    ) {
      // No run works on them (or none of them may go to Claude): the owner
      // has to look.
      this.notifyStuck(pull, triggers.headSha, merge);
    }
    if (idleRound) {
      return;
    }
    const current = this.records.pullRequest(pull.id);
    if (!current?.autofix || current.state !== 'open') {
      return;
    }
    const threads = merge?.kind === 'threads' ? merge : null;
    await this.startRun(current, repository, triggers, threads);
  }

  /**
   * Tells the owner once per head commit that automerge waits for review
   * threads no run works on (Claude left them open without asking, or
   * nobody who counts wrote them).
   */
  private notifyStuck(
    pull: PullRequestRecord,
    headSha: string,
    threads: { count: number; counting: ReviewThread[] },
  ): void {
    const current = this.records.pullRequest(pull.id);
    if (
      !current ||
      current.automergeHeldAt ||
      current.automergeNotifiedSha === headSha
    ) {
      return;
    }
    this.records.updatePullRequest(pull.id, { automergeNotifiedSha: headSha });
    const others = threads.count - threads.counting.length;
    const detail = `${threads.count} review thread${threads.count === 1 ? ' is' : 's are'} still unresolved${others > 0 ? ` (${others} by people the app does not trust)` : ''}; resolve ${threads.count === 1 ? 'it' : 'them'} on GitHub or tell the session what to do.`;
    this.sessions.recordEvent(pull.sessionId, {
      type: 'notice',
      level: 'warning',
      text: `Automerge of ${pull.repositoryName}#${pull.number} waits: ${detail}`,
    });
    this.notifications.notifyAutomerge(
      pull.sessionId,
      pullRequestDto(current),
      'waiting',
      detail,
    );
    this.sessions.publishUpdate(pull.sessionId);
  }

  /**
   * Merges a pull request with automerge whose head commit passed all
   * checks (approval not needed) and nobody who counts requests changes,
   * with nothing new to fix: unless Claude asked
   * for the owner's decision, it is a draft, GitHub refused this commit
   * before, or a review thread is unresolved. The merge is exactly of the
   * head commit that was checked; GitHub's refusal is told to the owner
   * once per head commit. A merge seen afterwards goes the usual way
   * (notification, autoclose).
   */
  private async automerge(
    pull: PullRequestRecord,
    repository: FeedbackRepository,
    headSha: string,
  ): Promise<AutomergeOutcome> {
    if (pull.automergeHeldAt) {
      this.setWaiting(pull.id, null);
      return { kind: 'blocked' };
    }
    if (pull.draft) {
      this.setWaiting(pull.id, 'the pull request is a draft');
      return { kind: 'blocked' };
    }
    if (pull.automergeFailedSha === headSha) {
      this.setWaiting(pull.id, null);
      return { kind: 'blocked' };
    }
    let threads: ReviewThread[];
    try {
      threads = await this.feedback.unresolvedThreads(repository, pull.number);
    } catch (error) {
      if (error instanceof GitHubRateLimitError) {
        throw error;
      }
      // Nothing is taken for resolved; the rest of the check goes on.
      this.logger.warn(
        `Could not read the review threads of ${pull.repositoryName}#${pull.number}: ${errorText(error)}`,
      );
      this.setWaiting(pull.id, 'the review threads could not be read');
      return { kind: 'blocked' };
    }
    if (threads.length > 0) {
      this.setWaiting(
        pull.id,
        `${threads.length} unresolved review thread${threads.length === 1 ? '' : 's'}`,
      );
      const counting: ReviewThread[] = [];
      for (const thread of threads) {
        if (await this.counts(repository, thread)) {
          counting.push(thread);
        }
      }
      return { kind: 'threads', count: threads.length, counting };
    }
    // Reading GitHub took a while: nothing may have changed meanwhile.
    const session = this.records.get(pull.sessionId);
    const current = this.records.pullRequest(pull.id);
    if (
      !session ||
      !current?.automerge ||
      current.automergeHeldAt ||
      current.state !== 'open' ||
      current.headSha !== headSha
    ) {
      return { kind: 'blocked' };
    }
    if (current.autofixRunning || !this.idle(session)) {
      // Looked at again when the session waits for a message again.
      this.deferred.add(pull.id);
      return { kind: 'blocked' };
    }
    const repositoryRecord = this.repositories.get(pull.repositoryId);
    if (!repositoryRecord || !isGitHubRepository(repositoryRecord)) {
      return { kind: 'blocked' };
    }
    const name = `${pull.repositoryName}#${pull.number}`;
    let method: MergeMethod | null = null;
    let failure: unknown = null;
    try {
      const result = await this.sessionGit.mergeOrEnqueue(
        current,
        repositoryRecord,
        headSha,
      );
      if (result.kind === 'queued') {
        this.mergeRetries.delete(`${pull.id}:${headSha}`);
        this.records.updatePullRequest(pull.id, { automergeWaiting: null });
        this.sessions.recordEvent(pull.sessionId, {
          type: 'notice',
          level: 'info',
          text: `Automerge ${result.already ? 'found' : 'added'} ${name} at ${headSha.slice(0, 7)} ${result.already ? 'in' : 'to'} the merge queue of ${pull.baseBranch}${result.position === null ? '' : ` (position ${result.position})`}: all checks passed, nobody requests changes and no review thread is unresolved. GitHub merges it once the queue's checks pass.`,
        });
        this.logger.log(`Automerge added ${name} to the merge queue`);
        this.sessions.publishUpdate(pull.sessionId);
        return { kind: 'queued' };
      }
      method = result.method;
    } catch (error) {
      if (error instanceof GitHubRateLimitError) {
        throw error;
      }
      failure = error;
    }
    // GitHub's state decides (a retried request may have merged already).
    const after = await this.sessionGit.refreshPullRequest(pull.id);
    if (
      !method &&
      after?.state === 'open' &&
      after.headSha !== null &&
      after.headSha !== headSha
    ) {
      // A push came in between: the new head commit is checked as usual.
      this.mergeRetries.delete(`${pull.id}:${headSha}`);
      return { kind: 'blocked' };
    }
    if (method || after?.state === 'merged') {
      this.mergeRetries.delete(`${pull.id}:${headSha}`);
      this.records.updatePullRequest(pull.id, { automergeWaiting: null });
      this.sessions.recordEvent(pull.sessionId, {
        type: 'notice',
        level: 'info',
        text: `Automerge merged ${name} at ${headSha.slice(0, 7)}${method ? ` (${method === 'merge' ? 'merge commit' : method})` : ''}: all checks passed, nobody requests changes and no review thread is unresolved.`,
      });
      this.logger.log(
        `Automerge merged ${name}${method ? ` (${method})` : ''}`,
      );
      this.sessions.publishUpdate(pull.sessionId);
      return { kind: 'merged' };
    }
    const key = `${pull.id}:${headSha}`;
    const retries = this.mergeRetries.get(key) ?? 0;
    if (transientMergeFailure(failure) && retries < MAX_MERGE_RETRIES) {
      this.mergeRetries.set(key, retries + 1);
      this.logger.warn(
        `Automerge of ${name} failed for now (${errorText(failure)}); trying again`,
      );
      this.schedule(pull.id, this.timing.ciRecheckMs);
      return { kind: 'blocked' };
    }
    this.mergeRetries.delete(key);
    const reason = errorText(failure ?? 'GitHub did not merge it');
    this.records.updatePullRequest(pull.id, {
      automergeFailedSha: headSha,
      automergeFailure: reason,
      automergeWaiting: null,
    });
    this.logger.warn(`Automerge of ${name} failed: ${reason}`);
    this.sessions.recordEvent(pull.sessionId, {
      type: 'notice',
      level: 'warning',
      text: `Automerge could not merge ${name} at ${headSha.slice(0, 7)}: ${reason}. It tries again with the next head commit, or when you turn automerge off and on.`,
    });
    this.notifications.notifyAutomerge(
      pull.sessionId,
      pullRequestDto(this.records.pullRequest(pull.id) ?? pull),
      'failed',
      reason,
    );
    this.sessions.publishUpdate(pull.sessionId);
    return { kind: 'blocked' };
  }

  /**
   * Whether Claude's tool `merge_pull_request` may merge a pull request of
   * the session without asking (the owner's decision): automerge is on for
   * it and it is ready as automerge sees it, read fresh from GitHub: open,
   * no draft, automerge not paused, all checks of the head commit passed
   * (at least one reported), nobody who counts requests changes, no new
   * reviews or comments since the last run and no unresolved review
   * thread. Approval is not needed. Returns the head commit it checked
   * (the tool merges exactly that one), `null` when it may not.
   */
  async mayMergeUnasked(
    sessionId: string,
    repositoryId: string,
    number: number,
  ): Promise<string | null> {
    if (!this.github.configured || this.hooks.reviewBusy?.(sessionId)) {
      // Without GitHub, or while an independent review runs (its findings
      // may come first): Claude asks as the mode says.
      return null;
    }
    const known = this.records
      .get(sessionId)
      ?.pullRequests.find(
        (entry) =>
          entry.repositoryId === repositoryId && entry.number === number,
      );
    if (!known?.automerge) {
      return null;
    }
    const pull = await this.sessionGit.refreshPullRequest(known.id);
    const repository = pull ? this.feedbackRepository(pull) : null;
    if (
      !pull ||
      !repository ||
      pull.state !== 'open' ||
      !pull.automerge ||
      pull.automergeHeldAt ||
      pull.draft ||
      !pull.headSha ||
      // GitHub refused this head commit, or the merge queue removed it
      // (handled or not): automerge does not try it again by itself.
      pull.automergeFailedSha === pull.headSha ||
      pull.mergeQueueRemovedSha === pull.headSha
    ) {
      return null;
    }
    const headSha = pull.headSha;
    const checks = await this.feedback.checks(repository, headSha);
    if (checks.length === 0 || !allPassed(checks)) {
      return null;
    }
    const after = pull.autofixReviewsAfter?.getTime() ?? 0;
    const items = await this.feedback.reviews(
      repository,
      number,
      new Date(after),
    );
    if (
      (await this.reviewVerdict(repository, items, headSha)).changesRequested
    ) {
      return null;
    }
    for (const item of items) {
      if (
        new Date(item.createdAt).getTime() > after &&
        !(
          item.kind === 'review' &&
          (item.body.trim() === '' ||
            item.state === 'DISMISSED' ||
            item.state === 'APPROVED')
        ) &&
        (await this.counts(repository, item))
      ) {
        // New feedback may ask for changes first.
        return null;
      }
    }
    if (
      (await this.feedback.unresolvedThreads(repository, number)).length > 0
    ) {
      return null;
    }
    const current = this.records.pullRequest(pull.id);
    return current?.state === 'open' &&
      current.automerge &&
      !current.automergeHeldAt &&
      current.headSha === headSha
      ? headSha
      : null;
  }

  /**
   * Handles merged or closed pull requests of a session whose close was
   * not handled yet (it waited for the end of a turn): all of them, as
   * `handleClosed` waits for any pull request once autoclose of the session
   * is due. Only in sessions with autoclose on a pull request and not
   * autoclosed yet: earlier versions left other closes unrecorded.
   */
  private handleUnhandledCloses(sessionId: string): void {
    const session = this.records.get(sessionId);
    if (
      !session ||
      session.autoclosedAt ||
      (!session.pullRequests.some((pull) => pull.autoclose) &&
        !session.pullRequests.some((pull) => extraCloneOf(session, pull)))
    ) {
      return;
    }
    for (const pull of session.pullRequests) {
      if (pull.state !== 'open' && !pull.closeHandledAt) {
        void this.handleClosed(pull.id).catch((error: unknown) =>
          this.logger.error(
            `Handling the close of ${pull.repositoryName}#${pull.number} failed: ${errorText(error)}`,
          ),
        );
      }
    }
  }

  /** Stores what keeps automerge waiting (published only on a change). */
  private setWaiting(pullRequestId: number, waiting: string | null): void {
    const pull = this.records.pullRequest(pullRequestId);
    if (!pull || pull.automergeWaiting === waiting) {
      return;
    }
    this.records.updatePullRequest(pullRequestId, {
      automergeWaiting: waiting,
    });
    this.sessions.publishUpdate(pull.sessionId);
  }

  /**
   * Failed checks of the head commit and new reviews that call for a run,
   * or a head commit that is ready to merge (all checks passed, approved).
   * Failures and feedback wait while other checks of the commit still run
   * (at most {@link PrAutomationTiming.ciSettleMs}), so that what belongs
   * together becomes one run: a reviewer bot's comments arrive while its
   * own check is still running.
   */
  private async triggers(
    pull: PullRequestRecord,
    repository: FeedbackRepository,
  ): Promise<Triggers> {
    const headSha = pull.headSha;
    const readAt = new Date();
    const checks = headSha
      ? await this.feedback.checks(repository, headSha)
      : [];
    if (headSha) {
      this.checksView?.store(pull.id, headSha, checks, readAt);
    }
    const pending = pendingChecks(checks);
    const failures =
      headSha && headSha !== pull.autofixCiHandledSha
        ? failedChecks(checks)
        : [];
    const after = pull.autofixReviewsAfter?.getTime() ?? Date.now();
    const items = await this.feedback.reviews(
      repository,
      pull.number,
      new Date(after),
    );
    const feedback: ReviewFeedback[] = [];
    const approvals: ReviewFeedback[] = [];
    const fresh = items
      .filter(
        (item) =>
          new Date(item.createdAt).getTime() > after &&
          // An empty review (an approval without text, or the container
          // of review comments) says nothing by itself; a dismissed one
          // was withdrawn.
          !(
            item.kind === 'review' &&
            (item.body.trim() === '' || item.state === 'DISMISSED')
          ),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const item of fresh) {
      if (!(await this.counts(repository, item))) {
        continue;
      }
      // An approval asks for nothing; its text goes along as context.
      (item.kind === 'review' && item.state === 'APPROVED'
        ? approvals
        : feedback
      ).push(item);
    }
    const checked = checks.length > 0;
    const green = headSha !== null && allPassed(checks);
    const verdict =
      green && headSha
        ? await this.reviewVerdict(repository, items, headSha)
        : { approved: false, changesRequested: false };
    // Automerge needs no approval (the owner's decision), but CI.
    const passed =
      green &&
      (verdict.approved ||
        (pull.automerge && checked && !verdict.changesRequested));
    // A commit with merge conflicts is not ready: it has to be rebased.
    const conflicting = pull.mergeConflict === true && headSha !== null;
    const conflict = conflicting && headSha !== pull.autofixConflictSha;
    const ready = passed && !conflicting && headSha !== pull.autofixReadySha;
    const dequeued =
      headSha !== null && pull.mergeQueueRemovedSha === headSha
        ? {
            reason: pull.mergeQueueRemovedReason ?? 'UNKNOWN',
            failed: await this.mergeGroupFailures(pull, repository),
          }
        : null;
    const key = `${pull.id}:${headSha}`;
    this.forgetWaiting(pull.id, key);
    if (pending.length === 0) {
      this.waitingSince.delete(key);
    } else if (failures.length > 0 || feedback.length > 0) {
      const since = this.waitingSince.get(key) ?? Date.now();
      this.waitingSince.set(key, since);
      if (Date.now() - since < this.timing.ciSettleMs && !conflict) {
        // One run for all checks of the commit: wait for the others (merge
        // conflicts do not wait: the rebase makes a new head commit).
        this.schedule(pull.id, this.timing.ciRecheckMs);
        return {
          failed: [],
          feedback: [],
          approvals: [],
          ready,
          passed,
          approved: verdict.approved,
          checked,
          headSha,
          conflict,
          conflicting,
          dequeued,
        };
      }
    }
    return {
      failed: failures.map((check) => ({ check, log: null })),
      feedback,
      approvals,
      ready,
      passed,
      approved: verdict.approved,
      checked,
      headSha,
      conflict,
      conflicting,
      dequeued,
    };
  }

  /**
   * The failed checks of the commit a merge queue tested for the pull
   * request (its merge group), when the app saw it; none when unknown or
   * unreadable.
   */
  private async mergeGroupFailures(
    pull: PullRequestRecord,
    repository: FeedbackRepository,
  ): Promise<FailedCheck[]> {
    if (!pull.mergeQueueGroupSha) {
      return [];
    }
    try {
      const checks = await this.feedback.checks(
        repository,
        pull.mergeQueueGroupSha,
      );
      return failedChecks(checks).map((check) => ({ check, log: null }));
    } catch (error) {
      if (error instanceof GitHubRateLimitError) {
        throw error;
      }
      this.logger.warn(
        `Could not read the checks of the merge group of ${pull.repositoryName}#${pull.number}: ${errorText(error)}`,
      );
      return [];
    }
  }

  /**
   * A pull request whose head commit changed after the merge queue took it
   * (GitHub removes it then): nothing failed, the history says so, and
   * automerge adds the new head commit once it is ready. Returns the
   * pull request as stored now.
   */
  private queueLeftByPush(pull: PullRequestRecord): PullRequestRecord {
    if (
      !pull.mergeQueueRemovedSha ||
      pull.mergeQueueRemovedSha === pull.headSha
    ) {
      return pull;
    }
    this.records.updatePullRequest(pull.id, {
      mergeQueueRemovedSha: null,
      mergeQueueRemovedReason: null,
    });
    this.sessions.recordEvent(pull.sessionId, {
      type: 'notice',
      level: 'info',
      text: `${pull.repositoryName}#${pull.number} left the merge queue: its head commit changed since it was added.`,
    });
    this.sessions.publishUpdate(pull.sessionId);
    return this.records.pullRequest(pull.id) ?? pull;
  }

  /**
   * The merge queue removed a pull request without autofix without merging
   * it: the history says so, the owner is notified, and Claude is woken if
   * it said it goes on by itself (`set_waiting_state` "work") and its turn
   * is over.
   */
  private async queueRemovalWithoutAutofix(
    pull: PullRequestRecord,
  ): Promise<void> {
    const current = this.queueLeftByPush(pull);
    if (!current.mergeQueueRemovedSha) {
      return;
    }
    const reason = queueReason(current.mergeQueueRemovedReason);
    const name = `${current.repositoryName}#${current.number}`;
    const key = removalKey(current);
    if (!this.queueRemovalsTold.has(key)) {
      // The owner learns it at once (once per removal).
      this.queueRemovalsTold.add(key);
      const ownerReason = ownerQueueReason(current.mergeQueueRemovedReason);
      const detail = `The merge queue of ${current.baseBranch} removed ${name} without merging it (${ownerReason}).`;
      this.sessions.recordEvent(current.sessionId, {
        type: 'notice',
        level: 'warning',
        text: detail,
      });
      this.notifications.notifyMergeQueueRemoval(
        current.sessionId,
        pullRequestDto(current),
        detail,
      );
      this.sessions.publishUpdate(current.sessionId);
    }
    const session = this.records.get(current.sessionId);
    if (session && !turnIsOver(this.sessions.get(session.id))) {
      // Claude may still say it goes on by itself in this turn: decided
      // when the turn is over.
      this.deferred.add(current.id);
      return;
    }
    this.queueRemovalsTold.delete(key);
    this.records.updatePullRequest(current.id, {
      mergeQueueRemovedSha: null,
      mergeQueueRemovedReason: null,
    });
    if (!session || !this.sessions.claudeGoesOn(session.id)) {
      return;
    }
    this.sessions.releaseClaudeWait(session.id);
    try {
      await this.sessions.sendMessage(session.id, {
        text: `The merge queue removed ${name} without merging it (${reason}). You said you go on by yourself: look at why with read-only commands (e.g. the runs of its merge group), fix what belongs to this pull request, and tell the user what needs their decision.`,
        origin: 'app',
      });
    } catch (error) {
      this.logger.warn(
        `Could not wake ${session.id} after ${name} left the merge queue: ${errorText(error)}`,
      );
      this.sessions.wakeFailed(session.id);
    }
  }

  /**
   * The merge queue removed the head commit of a pull request with
   * autofix: automerge does not add it again (as when GitHub refuses a
   * merge), only the next head commit or turning it off and on.
   */
  private noteQueueRemoval(
    pull: PullRequestRecord,
    headSha: string,
    reason: string,
  ): void {
    this.setWaiting(pull.id, null);
    if (!pull.automerge || pull.automergeFailedSha === headSha) {
      return;
    }
    this.records.updatePullRequest(pull.id, {
      automergeFailedSha: headSha,
      automergeFailure: `the merge queue removed it (${ownerQueueReason(reason)})`,
    });
    this.sessions.publishUpdate(pull.sessionId);
  }

  /** Drops what waited for other commits of a pull request than `keep`. */
  private forgetWaiting(pullRequestId: number, keep?: string): void {
    for (const map of [
      this.waitingSince,
      this.mergeRetries,
      this.mergeableRechecks,
    ]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${pullRequestId}:`) && key !== keep) {
          map.delete(key);
        }
      }
    }
  }

  /**
   * Whether a review or comment counts: by a trusted bot, or by a person
   * (not a bot) with write access to the repository.
   */
  private async counts(
    repository: FeedbackRepository,
    item: Pick<ReviewFeedback, 'author' | 'authorType'>,
  ): Promise<boolean> {
    if (item.author === null) {
      return false;
    }
    if (this.trustedBots.has(item.author.toLowerCase())) {
      return true;
    }
    if (item.authorType === 'Bot' || item.author.endsWith('[bot]')) {
      return false;
    }
    return this.feedback.canWrite(repository, item.author);
  }

  /**
   * Whether the head commit is approved (someone who counts, see
   * {@link counts}, approved exactly this commit with their latest deciding
   * review, and nobody who counts requests changes), and whether someone
   * who counts requests changes.
   */
  private async reviewVerdict(
    repository: FeedbackRepository,
    items: ReviewFeedback[],
    headSha: string,
  ): Promise<{ approved: boolean; changesRequested: boolean }> {
    const latest = new Map<string, ReviewFeedback>();
    for (const item of [...items].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    )) {
      if (
        item.kind === 'review' &&
        item.author !== null &&
        item.state !== null &&
        DECIDING_REVIEW_STATES.has(item.state)
      ) {
        latest.set(item.author.toLowerCase(), item);
      }
    }
    let approved = false;
    for (const review of latest.values()) {
      const approves =
        review.state === 'APPROVED' && review.commitId === headSha;
      if (review.state !== 'CHANGES_REQUESTED' && !approves) {
        continue;
      }
      if (!(await this.counts(repository, review))) {
        continue;
      }
      if (review.state === 'CHANGES_REQUESTED') {
        return { approved: false, changesRequested: true };
      }
      approved = true;
    }
    return { approved, changesRequested: false };
  }

  private async startRun(
    pull: PullRequestRecord,
    repository: FeedbackRepository,
    triggers: Triggers,
    /** Unresolved review threads that keep automerge from merging. */
    unresolved: { count: number; counting: ReviewThread[] } | null = null,
  ): Promise<void> {
    // Logs of failed GitHub Actions jobs (the job ID is the check run ID).
    let logs = 0;
    for (const failed of [
      ...triggers.failed,
      ...(triggers.dequeued?.failed ?? []),
    ]) {
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
    // Failed checks and feedback; with merge conflicts they come along.
    const also: Exclude<AutofixTrigger, 'ready' | 'conflict' | 'queue'> | null =
      triggers.failed.length > 0 && triggers.feedback.length > 0
        ? 'ci+review'
        : triggers.failed.length > 0
          ? 'ci'
          : triggers.feedback.length > 0
            ? 'review'
            : null;
    const trigger: AutofixTrigger = triggers.conflict
      ? 'conflict'
      : triggers.dequeued
        ? 'queue'
        : triggers.ready
          ? 'ready'
          : (also ?? 'review');
    // Unresolved threads go along with a ready message of automerge.
    const threads =
      trigger === 'ready' && current.automerge
        ? (unresolved?.counting ?? [])
        : [];
    const automerge: AutomergeNote | null = !current.automerge
      ? null
      : current.automergeHeldAt
        ? { state: 'held' }
        : current.automergeFailedSha !== null &&
            current.automergeFailedSha === triggers.headSha
          ? { state: 'refused' }
          : unresolved && trigger === 'ready'
            ? {
                state: 'threads',
                count: unresolved.count,
                counting: unresolved.counting.length,
              }
            : { state: 'on' };
    const directory = cloneOfPull(session.directories, pull);
    const branch = directory?.branch ?? pull.headBranch;
    const feedback = [...triggers.feedback, ...triggers.approvals].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt),
    );
    const text =
      trigger === 'ready'
        ? readyMessage({
            repository: pull.repositoryName,
            number: pull.number,
            headSha: triggers.headSha,
            branch,
            context:
              triggers.feedback.length > 0
                ? 'feedback'
                : feedback.length > 0
                  ? 'approvals'
                  : 'none',
            approved: triggers.approved,
            automerge,
          })
        : autofixMessage({
            repository: pull.repositoryName,
            number: pull.number,
            trigger,
            headSha: triggers.headSha,
            branch,
            automerge: current.automerge,
            conflict:
              trigger === 'conflict'
                ? { base: current.baseBranch, also }
                : undefined,
            queue:
              trigger === 'queue' && triggers.dequeued
                ? {
                    base: current.baseBranch,
                    reason: queueReason(triggers.dequeued.reason),
                    groupChecks: triggers.dequeued.failed.length,
                    also,
                  }
                : undefined,
          });
    const failed = [...triggers.failed, ...(triggers.dequeued?.failed ?? [])];
    // GitHub's reason in its own words, when it is not a plain enum name.
    const rawQueueReason =
      triggers.dequeued &&
      queueReason(triggers.dequeued.reason) === 'unknown reason' &&
      triggers.dequeued.reason !== 'UNKNOWN'
        ? triggers.dequeued.reason
        : undefined;
    const untrusted =
      failed.length > 0 ||
      feedback.length > 0 ||
      threads.length > 0 ||
      rawQueueReason !== undefined
        ? autofixContext({
            repository: pull.repositoryName,
            number: pull.number,
            failed,
            feedback,
            ready: trigger === 'ready',
            threads,
            queueRemoval: rawQueueReason,
          })
        : undefined;
    const now = new Date();
    const newest = feedback.at(-1)?.createdAt;
    this.records.updatePullRequest(pull.id, {
      autofixLastRunAt: now,
      autofixLastTrigger: trigger,
      ...(triggers.failed.length > 0
        ? { autofixCiHandledSha: triggers.headSha }
        : {}),
      ...(trigger === 'conflict'
        ? { autofixConflictSha: triggers.headSha }
        : {}),
      // After a removal from the merge queue the run says it all: no
      // ready message for this head commit later.
      ...(trigger === 'ready' || trigger === 'queue'
        ? { autofixReadySha: triggers.headSha }
        : {}),
      ...(triggers.dequeued
        ? { mergeQueueRemovedSha: null, mergeQueueRemovedReason: null }
        : {}),
      ...(newest ? { autofixReviewsAfter: new Date(newest) } : {}),
    });
    this.logger.log(
      trigger === 'ready'
        ? `Told the session that ${pull.repositoryName}#${pull.number} is ready to merge`
        : `Autofix run for ${pull.repositoryName}#${pull.number} (${trigger})`,
    );
    const removal = triggers.dequeued ? removalKey(current) : null;
    if (triggers.dequeued && removal && !this.queueRemovalsTold.has(removal)) {
      // Also when a conflict run handles it; once, also when the run
      // cannot start now and is tried again.
      this.queueRemovalsTold.add(removal);
      this.sessions.recordEvent(pull.sessionId, {
        type: 'notice',
        level: 'warning',
        text: `The merge queue of ${pull.baseBranch} removed ${pull.repositoryName}#${pull.number} without merging it (${ownerQueueReason(triggers.dequeued.reason)}).`,
      });
    }
    try {
      await this.sessions.sendMessage(pull.sessionId, {
        text,
        origin: 'app',
        untrusted,
        autofixRun: true,
      });
    } catch (error) {
      // The run did not start: it is tried again later.
      this.records.updatePullRequest(pull.id, {
        autofixCiHandledSha: current.autofixCiHandledSha,
        autofixConflictSha: current.autofixConflictSha,
        autofixReadySha: current.autofixReadySha,
        autofixReviewsAfter: current.autofixReviewsAfter,
        mergeQueueRemovedSha: current.mergeQueueRemovedSha,
        mergeQueueRemovedReason: current.mergeQueueRemovedReason,
      });
      this.logger.warn(
        `The autofix run for ${pull.repositoryName}#${pull.number} could not start: ${errorText(error)}`,
      );
      this.sessions.publishUpdate(pull.sessionId);
      return;
    }
    // The run (or ready message) tells Claude about this pull request's CI.
    this.ciSettled.get(pull.sessionId)?.delete(pull.id);
    if (removal) {
      this.queueRemovalsTold.delete(removal);
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
    if (!turnIsOver(session)) {
      return;
    }
    // Closes whose autoclose waited for the end of the turn.
    this.handleUnhandledCloses(session.id);
    // Free for a run (see `idle`): waits for a message, or only for what
    // Claude said it goes on with by itself.
    const free =
      session.status === 'waiting' &&
      this.sessions.acceptsAppMessage(session.id);
    let changed = false;
    for (const pull of session.pullRequests) {
      if (pull.automation.running) {
        this.records.updatePullRequest(pull.id, { autofixRunning: false });
        changed = true;
        if (pull.automation.automerge.enabled && free) {
          // Nothing left to fix may mean ready to merge now.
          this.schedule(pull.id, this.timing.idleRecheckMs);
        }
      }
      if (this.deferred.has(pull.id) && free) {
        this.deferred.delete(pull.id);
        this.schedule(pull.id, this.timing.idleRecheckMs);
      }
    }
    if (changed) {
      this.sessions.publishUpdate(session.id);
    }
    if (this.ciSettled.has(session.id)) {
      // CI that settled before the other CI, background tasks or a review
      // of the session ended.
      this.wakeAfterCiLater(session.id);
    }
  }

  /**
   * Whether an autofix run may start now: the session waits for a message,
   * or only because Claude said it goes on by itself (`set_waiting_state`
   * with `work`, typically "CI and review of PR #12") without background
   * tasks still running. Claude then waits for what the run brings: holding
   * the run back until Claude's word runs out would make both wait.
   */
  private idle(session: SessionRecord): boolean {
    if (session.status !== 'waiting' || session.pendingMessage) {
      return false;
    }
    if (this.hooks.reviewBusy?.(session.id)) {
      // An independent review runs: its findings may come first.
      return false;
    }
    return (
      this.sessions.acceptsAppMessage(session.id) &&
      session.directories.every(
        (directory) =>
          !isActiveDirectory(directory) || directory.state === 'ready',
      )
    );
  }

  // --- git during autofix -------------------------------------------------

  /**
   * During autofix Claude may stage, commit and push the session branch of
   * the pull request without asking: a command that is nothing but
   * `git add`, `git commit` and `git push` joined with `&&` (see
   * `parseAutofixGitCommand`). The app carries it out itself instead of a
   * shell: `git add` and `git commit` run as the session user with hooks
   * off and only plain clone configuration, and the push is the Push
   * button's (only the session branch, no force, no token in the session).
   * Steps stop at the first failure, like `&&`. Everything else goes to the
   * user as usual (`null`): other commands, other branches or remotes,
   * force, tags, deletions, amending a pushed commit, clones whose git
   * configuration could run programs, and new commits that change workflow
   * files (those are committed, but the push then asks).
   */
  async autofixCommand(
    sessionId: string,
    command: string,
    pushes: GitPushAnalysis[],
  ): Promise<AutofixCommandOutcome | null> {
    const parsed = parseAutofixGitCommand(command);
    if (!parsed) {
      return null;
    }
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
    const pushing = parsed.steps.some((step) => step.kind === 'push');
    const local = parsed.steps.filter((step) => step.kind !== 'push');
    // A plain `git push --force-with-lease` (conflict runs only, see below).
    const lease = pushing && pushes.length === 1 && pushes[0].leaseOnly;
    if (
      pushing &&
      (pushes.length !== 1 ||
        pushes.some(
          (push) =>
            !(push.sessionBranchOnly || push.leaseOnly) ||
            (push.force && !push.leaseOnly) ||
            push.deletes ||
            push.everything ||
            (push.remote !== null && push.remote !== 'origin'),
        ))
    ) {
      return null;
    }
    let targets = autofixClones;
    if (lease) {
      // Forcing only for pull requests whose conflict run goes on.
      // Only the branch of the clone it pushes (HEAD or its name).
      const named = pushes[0].targets.map((target) => target.branch);
      targets = autofixClones.filter(
        (directory) =>
          this.conflictRunPull(session, directory) !== null &&
          named.every(
            (branch) => branch === 'HEAD' || branch === directory.branch,
          ),
      );
      if (targets.length === 0) {
        return null;
      }
    }
    if (parsed.location) {
      // Relative to where the process runs (after switch_directory the old
      // directory until it restarts).
      let location = this.sessions.processDirectory(session.id);
      for (const path of parsed.location) {
        location = isAbsolute(path) ? resolve(path) : resolve(location, path);
      }
      const target = targets.find(
        (directory) =>
          location === directory.path ||
          location.startsWith(directory.path + sep),
      );
      if (!target) {
        return null;
      }
      targets = [target];
    } else if (local.length > 0) {
      // The shell's directory is unknown: only a session with one clone
      // (clones removed after their pull request do not count).
      const clones = session.directories.filter(
        (directory) =>
          directory.kind === 'clone' && directory.state === 'ready',
      );
      if (clones.length !== 1 || autofixClones.length !== 1) {
        return null;
      }
    }
    if (local.length > 0) {
      const [target] = targets;
      if (
        targets.length !== 1 ||
        (await this.git.currentBranch(target.path)) !== target.branch ||
        !(await this.git.cloneConfigIsPlain(target.path))
      ) {
        return null;
      }
      if (local.some((step) => step.kind === 'commit' && step.amend)) {
        const head = await this.git.localBranchCommit(
          target.path,
          target.branch,
        );
        // Amending a pushed commit would need a force push.
        if (!head || (await this.git.isOnRemote(target.path, head))) {
          return null;
        }
      }
    } else if (await this.pushNeedsApproval(session, targets, lease)) {
      return null;
    }
    const output: string[] = [];
    const summary: string[] = [];
    let ok = true;
    for (const step of local) {
      const [target] = targets;
      const args = [step.kind, ...step.args];
      const result = await this.git.runCloneCommand(target.path, args);
      output.push(
        `$ git ${step.kind} … (in ${target.repositoryName})`,
        result.output.trim() || '(no output)',
      );
      if (!result.ok) {
        ok = false;
        summary.push(`git ${step.kind} failed`);
        break;
      }
      summary.push(step.kind === 'add' ? 'Staged' : 'Committed');
    }
    if (pushing && ok) {
      const pushed = await this.pushForAutofix(session, targets, lease);
      output.push(...pushed.output);
      summary.push(...pushed.summary);
      ok = pushed.ok;
    } else if (pushing) {
      output.push('Not pushed, because a step before failed.');
    }
    const head = [
      ok
        ? 'Done by the app (autofix runs these git commands itself; no other command ran).'
        : 'Failed (autofix runs these git commands itself; no other command ran).',
    ];
    return {
      ok,
      output: [...head, ...output].join('\n'),
      summary: summary.join('; ') || (ok ? 'Done' : 'Failed'),
    };
  }

  /**
   * The open pull request with autofix of a clone's branch whose conflict
   * run goes on (from its message until the end of its turn), or `null`.
   */
  private conflictRunPull(
    session: SessionRecord,
    directory: SessionDirectoryRecord,
  ): PullRequestRecord | null {
    if (!this.sessions.inAutofixRun(session.id)) {
      // The live marker of the run, not only what the database says.
      return null;
    }
    return (
      session.pullRequests.find(
        (pull) =>
          pull.repositoryId === directory.repositoryId &&
          pull.headBranch === directory.branch &&
          pull.state === 'open' &&
          pull.autofix &&
          pull.autofixRunning &&
          pull.autofixLastTrigger === 'conflict',
      ) ?? null
    );
  }

  /**
   * For a force push after a rebase: the pull request in its conflict run
   * and the commit of its base branch on GitHub (read now; `null` when it
   * cannot be read). Not the clone's `origin/<base>`: the session can set
   * its refs to anything.
   */
  private async leaseBase(
    session: SessionRecord,
    directory: SessionDirectoryRecord,
  ): Promise<{ pull: PullRequestRecord | null; base: string | null }> {
    const pull = this.conflictRunPull(session, directory);
    if (!pull) {
      return { pull, base: null };
    }
    try {
      return { pull, base: await this.sessionGit.baseBranchCommit(pull.id) };
    } catch (error) {
      this.logger.warn(
        `Could not read ${pull.baseBranch} of ${pull.repositoryName}: ${errorText(error)}`,
      );
      return { pull, base: null };
    }
  }

  /**
   * Whether new commits of the clones change workflow files. After a rebase
   * (`lease`) the branch's workflow files are compared with those of the
   * base branch on GitHub (as trees, so a merge commit counts too); when
   * that cannot be read, the push asks.
   */
  private async pushNeedsApproval(
    session: SessionRecord,
    targets: (SessionDirectoryRecord & { branch: string })[],
    lease: boolean,
  ): Promise<boolean> {
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
      if (lease) {
        const { base } = await this.leaseBase(session, directory);
        const differ = base
          ? await this.git.workflowsDiffer(directory.path, base, head)
          : true;
        // Unknown (the clone lacks the base commit): the push refuses it.
        if (differ === true) {
          return true;
        }
      } else if (
        await this.git.changesWorkflows(
          directory.path,
          head,
          remote ?? directory.baseCommit,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Pushes the session branches like the Push button; with `lease` (a
   * conflict run's `git push --force-with-lease`) as a force push over the
   * commit the clone last saw on GitHub, and only when the branch contains
   * the commit of the base branch on GitHub (it was rebased onto it).
   */
  private async pushForAutofix(
    session: SessionRecord,
    targets: (SessionDirectoryRecord & {
      branch: string;
      repositoryId: string;
    })[],
    lease: boolean,
  ): Promise<{ ok: boolean; output: string[]; summary: string[] }> {
    const output: string[] = [];
    const summary: string[] = [];
    let ok = true;
    if (await this.pushNeedsApproval(session, targets, lease)) {
      return {
        ok: false,
        output: [
          'Not pushed: the new commits change files under .github/workflows, which needs the approval of the user. Run git push as a command of its own to ask for it.',
        ],
        summary: ['not pushed (workflow files changed: needs approval)'],
      };
    }
    for (const directory of targets) {
      const name = `${directory.branch} of ${directory.repositoryName}`;
      const head = await this.git.localBranchCommit(
        directory.path,
        directory.branch,
      );
      const remote = await this.git.remoteBranchCommit(
        directory.path,
        directory.branch,
      );
      if (!head || head === remote) {
        output.push(
          `Nothing to push for ${directory.repositoryName}: GitHub has the latest commit of ${directory.branch} already.`,
        );
        continue;
      }
      let leaseOn: string | undefined;
      if (lease) {
        const { pull, base } = await this.leaseBase(session, directory);
        const problem = !pull
          ? 'no conflict run goes on for its pull request'
          : !remote
            ? `the clone does not know ${directory.branch} on GitHub (git fetch origin ${directory.branch} first)`
            : !base
              ? `${pull.baseBranch} could not be read from GitHub`
              : !(await this.git.isAncestor(directory.path, base, head))
                ? `${directory.branch} does not contain the latest ${pull.baseBranch} of GitHub (${base.slice(0, 7)}): git fetch origin ${pull.baseBranch} and rebase onto origin/${pull.baseBranch} first`
                : null;
        if (problem || !remote) {
          ok = false;
          output.push(`Not force-pushed ${name}: ${problem}.`);
          summary.push(`not force-pushed ${directory.repositoryName}`);
          continue;
        }
        leaseOn = remote;
      }
      try {
        const commit = await this.sessionGit.push(
          session.id,
          directory.repositoryId,
          directory.branch,
          leaseOn ? { lease: leaseOn } : {},
        );
        output.push(
          leaseOn
            ? `Force-pushed ${name} to GitHub at ${commit.slice(0, 7)}, with a lease on ${leaseOn.slice(0, 7)}.`
            : `Pushed ${name} to GitHub at ${commit.slice(0, 7)} (no force).`,
        );
        summary.push(
          `${leaseOn ? 'force-pushed (with lease)' : 'pushed'} ${name} at ${commit.slice(0, 7)}`,
        );
      } catch (error) {
        ok = false;
        output.push(`Push of ${name} failed: ${errorText(error)}`);
        summary.push(`push of ${directory.repositoryName} failed`);
      }
    }
    if (summary.length === 0 && ok) {
      summary.push('nothing to push');
    }
    return { ok, output, summary };
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
    const owner = this.records.get(pull.sessionId);
    const ownClone = owner ? extraCloneOf(owner, pull) : null;
    const autocloseDue =
      !!owner &&
      owner.pullRequests.some((entry) => entry.autoclose) &&
      owner.pullRequests.every(
        (entry) => entry.id === pull.id || entry.state !== 'open',
      );
    const turnRuns = !!owner && !turnIsOver(this.sessions.get(owner.id));
    if (turnRuns) {
      // Claude sees it in this turn (or merged it itself): no wake later.
      this.closedInTurn.add(pull.id);
    }
    // Claude said it goes on by itself: the close wakes it. Its own wait
    // then does not keep the process (the wake starts a new turn).
    const wake =
      !!owner &&
      !owner.autoclosedAt &&
      !autocloseDue &&
      !this.closedInTurn.has(pull.id) &&
      this.sessions.claudeGoesOn(owner.id);
    if (
      owner &&
      !owner.autoclosedAt &&
      (((autocloseDue || ownClone) && turnRuns) ||
        // Claude Code works in the clone and its process must stay
        // (background tasks, its own wait, previews): moving it away
        // would end them. Also when the working directory was switched
        // already but the process still runs in the clone.
        (!autocloseDue &&
          ownClone !== null &&
          (workingDirectoryOf(owner).position === ownClone.position ||
            this.sessions.processDirectory(owner.id) === ownClone.path) &&
          this.sessions.processMustStay(owner.id, {
            exceptClaudeWait: wake,
          })))
    ) {
      // Autoclose would end the turn that is going (e.g. the one that
      // merged it with Claude's tool, or one waiting for an approval), or
      // the clone of the pull request's own branch would go while Claude
      // may still work in it: the close stays unhandled until the turn is
      // over, or the process is free (`sessionChanged`, or the first poll
      // after a restart).
      return;
    }
    this.forgetWaiting(pull.id);
    this.closedInTurn.delete(pull.id);
    this.records.updatePullRequest(pull.id, {
      closeHandledAt: new Date(),
      autofixRunning: false,
    });
    if (wake) {
      // Synchronously, before any await: a second close at the same time
      // finds no wait left and sends no second wake.
      this.sessions.releaseClaudeWait(pull.sessionId);
    }
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
    } else {
      if (pull.autoclose && open.length > 0) {
        this.sessions.recordEvent(session.id, {
          type: 'notice',
          level: 'info',
          text: `${pull.repositoryName}#${pull.number} was ${pull.state}. Autoclose waits until ${open.map((entry) => `${entry.repositoryName}#${entry.number}`).join(', ')} ${open.length === 1 ? 'is' : 'are'} merged or closed too.`,
        });
      }
      const extra = extraCloneOf(session, pull);
      if (extra) {
        await this.removeExtraClone(session, pull, extra);
      }
    }
    this.notifications.notifyPullRequestClosed(
      session.id,
      pullRequestDto(this.records.pullRequest(pull.id) ?? pull),
      note,
    );
    this.sessions.publishUpdate(session.id);
    if (wake && !autoclose) {
      await this.wakeAfterClose(session.id, pull);
    }
  }

  /**
   * Claude said it goes on by itself (`set_waiting_state` "work") and the
   * CI of its pull requests settled (passed or not) without a run, ready
   * message or merge taking the turn over: it is woken with the outcome,
   * once no CI of the session runs any more (one wake for all), and only
   * when an app message may start a turn (no background task or review
   * still to report). Pull requests in a merge queue (the merge wakes it)
   * or closed meanwhile are left out. CI that settled during a turn is
   * kept until the turn is over: it wakes Claude if the turn ended with
   * "work" (owner's decision; Claude may have seen it already). When the
   * session waits for the user, nothing is sent.
   */
  private wakeAfterCiLater(sessionId: string): void {
    this.wakeAfterCi(sessionId).catch((error: unknown) =>
      this.logger.warn(
        `Waking ${sessionId} after its CI failed: ${errorText(error)}`,
      ),
    );
  }

  private async wakeAfterCi(sessionId: string): Promise<void> {
    const pending = this.ciSettled.get(sessionId);
    if (!pending) {
      return;
    }
    const session = this.records.get(sessionId);
    if (!session) {
      this.ciSettled.delete(sessionId);
      return;
    }
    if (!turnIsOver(this.sessions.get(sessionId))) {
      // Decided when the turn is over (`sessionChanged`).
      return;
    }
    if (!this.sessions.claudeGoesOn(sessionId)) {
      this.ciSettled.delete(sessionId);
      return;
    }
    if (
      this.sessions.waitsForCi(sessionId) ||
      !this.idle(session) ||
      [...pending].some(
        (id) =>
          this.deferred.has(id) || this.timers.has(id) || this.checking.has(id),
      )
    ) {
      // Again when the session changes (`sessionChanged`), or after the
      // check of a pull request that is deferred, scheduled or running:
      // its autofix run, ready message or merge comes first.
      return;
    }
    const lines: string[] = [];
    for (const pull of session.pullRequests) {
      if (
        !pending.has(pull.id) ||
        pull.state !== 'open' ||
        !pull.headSha ||
        (pull.mergeQueuedSha !== null && pull.mergeQueuedSha === pull.headSha)
      ) {
        continue;
      }
      const checks =
        pull.checks?.headSha === pull.headSha ? pull.checks.checks : [];
      if (
        checks.length === 0 ||
        checks.some((check) => check.state === 'pending')
      ) {
        continue;
      }
      const passed = checks.filter((check) =>
        PASSED_CONCLUSIONS.has(check.state),
      ).length;
      const outcome =
        passed === checks.length
          ? `all ${checks.length} check${checks.length === 1 ? '' : 's'} passed`
          : `${checks.length - passed} of ${checks.length} check${checks.length === 1 ? '' : 's'} did not pass`;
      lines.push(
        `- ${pull.repositoryName}#${pull.number} at ${pull.headSha.slice(0, 7)}: ${outcome}`,
      );
    }
    this.ciSettled.delete(sessionId);
    if (lines.length === 0) {
      return;
    }
    // Synchronously, before any await: a close or another check at the
    // same time finds no wait left and sends no second wake.
    this.sessions.releaseClaudeWait(sessionId);
    const text = `The CI of your pull request${lines.length === 1 ? '' : 's'} finished:\n${lines.join('\n')}\nYou said you go on by yourself: continue with what comes next. Look at checks that did not pass with read-only commands (e.g. gh pr checks, gh run view --log-failed) and fix what belongs to the pull request.`;
    try {
      await this.sessions.sendMessage(sessionId, { text, origin: 'app' });
      this.logger.log(`Woke ${sessionId}: CI finished`);
    } catch (error) {
      this.logger.warn(
        `Could not wake ${sessionId} after its CI finished: ${errorText(error)}`,
      );
      this.sessions.wakeFailed(sessionId);
    }
  }

  /**
   * Claude said it goes on by itself (`set_waiting_state` "work"): a merge
   * or close of one of its pull requests wakes it, so that it continues
   * without the user saying so. Not while a turn runs (Claude merged it
   * itself, or sees it there), nor when autoclose ended the session.
   */
  private async wakeAfterClose(
    sessionId: string,
    pull: PullRequestRecord,
  ): Promise<void> {
    const name = `${pull.repositoryName}#${pull.number}`;
    // Branch names come from GitHub: only plain ones go into the text
    // (app text must not contain @).
    const base = /^[\w./-]+$/.test(pull.baseBranch)
      ? pull.baseBranch
      : 'its base branch';
    const text =
      pull.state === 'merged'
        ? `${name} was merged into ${base}. You said you go on by yourself: continue with what comes next. Fetch ${base} before you build on it; the merge may have rewritten the commits of the session branch.`
        : `${name} was closed without merging. You said you go on by yourself: decide what follows, and ask the user if it needs their decision.`;
    try {
      await this.sessions.sendMessage(sessionId, { text, origin: 'app' });
      this.logger.log(`Woke ${sessionId}: ${name} was ${pull.state}`);
    } catch (error) {
      this.logger.warn(
        `Could not wake ${sessionId} after ${name} was ${pull.state}: ${errorText(error)}`,
      );
      this.sessions.recordEvent(sessionId, {
        type: 'notice',
        level: 'warning',
        text: `${name} was ${pull.state}, but Claude could not be woken to go on: ${errorText(error)}`,
      });
      this.sessions.wakeFailed(sessionId);
    }
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
    const leftovers: string[] = [];
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
        const rest = await this.removeClone(session, directory);
        if (rest) {
          leftovers.push(rest);
        }
      } else {
        kept.push(name);
        details.push(`${name}: ${describeLoss(loss)}`);
      }
    }
    await this.removeEmptyParents(session);
    const what = `${pull.repositoryName}#${pull.number} was ${pull.state}`;
    const rest = leftovers.length > 0 ? ` ${leftoversNote(leftovers)}` : '';
    this.sessions.recordEvent(session.id, {
      type: 'notice',
      level: kept.length > 0 || leftovers.length > 0 ? 'warning' : 'info',
      text:
        kept.length > 0
          ? `${what}. Autoclose ended the session and removed its clones, but kept ${kept.length === 1 ? 'one' : kept.length} with work that is not on GitHub (${details.join('; ')}). Delete ${kept.length === 1 ? 'it' : 'them'} in the session view when you no longer need ${kept.length === 1 ? 'it' : 'them'}.${rest}`
          : `${what}. Autoclose ended the session and removed its clones.${rest}`,
    });
    return kept;
  }

  /**
   * The pull request of a clone was merged or closed while the session has
   * other directories: the clone goes (`retired`), unless it has work that
   * is not on GitHub. When it is Claude Code's working directory, the app
   * switches to another first (another clone of the repository, else the
   * first directory left). The session goes on in its other directories;
   * Claude is told with its next message, and an idle Claude Code process
   * is restarted without the directory.
   */
  private async removeExtraClone(
    session: SessionRecord,
    pull: PullRequestRecord,
    directory: SessionDirectoryRecord,
  ): Promise<void> {
    const what = `${pull.repositoryName}#${pull.number} was ${pull.state}`;
    const name = `the clone of ${directory.repositoryName} on ${directory.branch}`;
    let detail: string | null = null;
    try {
      const loss = await this.git.cloneLoss(directory.path, {
        knownRemoteCommits: this.remoteHeads(session, directory),
      });
      if (!lossIsEmpty(loss)) {
        detail = describeLoss(loss);
      }
    } catch (error) {
      detail = `it could not be checked (${errorText(error)})`;
    }
    if (detail === null && !turnIsOver(this.sessions.get(session.id))) {
      // A turn started while the clone was checked: Claude may work in it
      // again. The close is handled already, so the clone stays.
      detail = 'a turn started meanwhile';
    }
    let rest: string | null = null;
    const finish = () => {
      this.sessions.recordEvent(session.id, {
        type: 'notice',
        level: detail === null && rest === null ? 'info' : 'warning',
        text:
          detail === null
            ? `${what}: removed ${name} (${directory.path}).${rest ? ` ${leftoversNote([rest])}` : ''}`
            : `${what}: kept ${name} (${directory.path}): ${detail}.`,
      });
      this.logger.log(
        `${what}: ${detail === null ? 'removed' : 'kept'} ${directory.path}`,
      );
    };
    let switched: { from: number; note: string } | null = null;
    if (detail === null) {
      try {
        // Claude Code must not keep working in it.
        switched = this.switchAwayFrom(session, directory);
      } catch (error) {
        detail = `no other directory to work in (${errorText(error)})`;
      }
    }
    if (detail !== null) {
      finish();
      return;
    }
    // Retired before the files go (that can take a while), and messages
    // sent meanwhile wait until it is gone: no turn starts in a process
    // that still has the directory, and Claude is told with the message.
    this.records.updateDirectory(session.id, directory.position, {
      additionState: 'retired',
      announce: true,
    });
    await this.sessions.holdMessagesWhile(session.id, async () => {
      try {
        // Leftovers: the clone is gone all the same (removed).
        rest = await this.removeClone(session, directory);
        await this.removeEmptyParents(session);
      } catch (error) {
        detail = `removing it failed (${errorText(error)})`;
        // It stays, and Claude goes on working in it.
        this.records.updateDirectory(session.id, directory.position, {
          // A directory the session started with is no addition again.
          additionState: directory.addition ? directory.addition.state : null,
          announce: false,
        });
        if (switched) {
          // Back where Claude worked; nothing to tell.
          this.sessions.switchWorkingDirectory(session.id, switched.from);
          switched = null;
        }
      }
      if (switched) {
        this.sessions.noteForClaude(session.id, switched.note);
      }
      finish();
      // An idle process is restarted without the directory.
      this.sessions.directoryRetired(session.id);
    });
  }

  /**
   * Makes another directory the working directory when `directory`, about
   * to be removed, is it: another clone of its repository, else the first
   * directory Claude works in. Returns what to undo and to tell Claude once
   * the removal succeeded; `null` when it was not the working directory.
   */
  private switchAwayFrom(
    session: SessionRecord,
    directory: SessionDirectoryRecord,
  ): { from: number; note: string } | null {
    const current = this.records.get(session.id) ?? session;
    if (workingDirectoryOf(current).position !== directory.position) {
      return null;
    }
    const usable = current.directories.filter(
      (entry) =>
        entry.position !== directory.position &&
        entry.state === 'ready' &&
        isActiveDirectory(entry),
    );
    const next =
      usable.find(
        (entry) =>
          entry.kind === 'clone' &&
          entry.repositoryId === directory.repositoryId,
      ) ?? usable[0];
    if (!next) {
      throw new Error('no other directory to work in');
    }
    this.sessions.switchWorkingDirectory(session.id, next.position);
    return {
      from: directory.position,
      note:
        `Your working directory is now ${next.path}${next.branch ? ` (branch ${next.branch})` : ''}: ` +
        `the session manager switched to it because ${directory.path} was removed after its pull request.`,
    };
  }

  // --- Kept clones ---------------------------------------------------------

  /** What deleting a session clone would lose. */
  async cloneLoss(
    sessionId: string,
    repositoryId: string,
    branch: string | null = null,
  ): Promise<CloneLossReport> {
    const session = this.requireSession(sessionId);
    const directory = this.requireClone(session, repositoryId, branch);
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
    branch: string | null = null,
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
    const directory = this.requireClone(session, repositoryId, branch);
    const rest = await this.removeClone(session, directory);
    await this.removeEmptyParents(session);
    this.sessions.recordEvent(sessionId, {
      type: 'notice',
      level: rest ? 'warning' : 'info',
      text: `The clone of ${directory.repositoryName} on ${directory.branch} was deleted.${rest ? ` ${leftoversNote([rest])}` : ''}`,
    });
    this.sessions.publishUpdate(sessionId);
    return this.sessions.get(sessionId);
  }

  // -------------------------------------------------------------------------

  /**
   * Removes a clone (stopping what runs in it first, see
   * {@link WorkspaceEntries.remove}). When deleting started but files are
   * left, the clone is unusable all the same: it counts as removed (its
   * rest shows among the workspace's directories without session), and
   * the error text is returned.
   */
  private async removeClone(
    session: SessionRecord,
    directory: SessionDirectoryRecord,
  ): Promise<string | null> {
    let rest: string | null = null;
    try {
      await new WorkspaceEntries(this.config, this.git.launcher).remove(
        directory.path,
        cloneRule(session.slug),
        this.otherSessionPaths(session.id),
      );
    } catch (error) {
      if (!(error instanceof IncompleteRemovalError)) {
        throw error;
      }
      this.logger.warn(error.message);
      rest = error.message;
    }
    this.records.updateDirectory(session.id, directory.position, {
      state: 'removed',
    });
    return rest;
  }

  /** Directories of other sessions, which a removal must never reach. */
  private otherSessionPaths(sessionId: string): string[] {
    return this.records
      .list()
      .filter((session) => session.id !== sessionId)
      .flatMap((session) => session.directories.map((entry) => entry.path));
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
      .filter(
        (pull) =>
          pull.repositoryId === directory.repositoryId &&
          cloneOfPull(session.directories, pull)?.position ===
            directory.position,
      )
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
    branch: string | null,
  ): SessionDirectoryRecord {
    const directory = cloneOf(session.directories, repositoryId, branch);
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
 * The clone a closed pull request came from, if its close removes it: a
 * ready one Claude works in, not while another open pull request comes
 * from it, and never the session's last such directory (a working
 * directory goes after the app switched away from it, see
 * `removeExtraClone`).
 */
function extraCloneOf(
  session: SessionRecord,
  pull: PullRequestRecord,
): SessionDirectoryRecord | null {
  if (pull.state === 'open' || pull.closeHandledAt) {
    return null;
  }
  const directory = session.directories.find(
    (entry) =>
      entry.kind === 'clone' &&
      entry.repositoryId === pull.repositoryId &&
      entry.branch === pull.headBranch,
  );
  if (
    !directory ||
    directory.state !== 'ready' ||
    !isActiveDirectory(directory) ||
    !retiresAfterPullRequest(session.directories, directory) ||
    !session.directories.some(
      (entry) =>
        entry.position !== directory.position &&
        entry.state === 'ready' &&
        isActiveDirectory(entry),
    ) ||
    session.pullRequests.some(
      (entry) =>
        entry.id !== pull.id &&
        entry.state === 'open' &&
        entry.repositoryId === pull.repositoryId &&
        entry.headBranch === directory.branch,
    )
  ) {
    return null;
  }
  return directory;
}
