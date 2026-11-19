import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import type {
  PullRequestCheckDto,
  PullRequestChecksDto,
  PullRequestCheckState,
} from '@claude-remote-manager/shared-types';
import { GitHubRateLimitError } from '../github/github-errors';
import { GitHubService } from '../github/github.service';
import { isGitHubRepository } from '../repositories/repository-credentials';
import { RepositoryRepository } from '../repositories/repository.repository';
import { SessionGitService } from '../sessions/session-git.service';
import {
  SessionRepository,
  type PullRequestRecord,
} from '../sessions/session.repository';
import { SessionsService } from '../sessions/sessions.service';
import { ViewerPresence } from '../sessions/viewer-presence';
import {
  FAILED_CONCLUSIONS,
  PullRequestFeedback,
  type CheckResult,
} from './pull-request-feedback';

export interface PullRequestChecksTiming {
  /** Polling of viewed sessions (0: off). */
  pollMs: number;
  /** Settled checks of a viewed session are read again after this time. */
  staleMs: number;
  /** A read waits this long after the last webhook delivery... */
  debounceMs: number;
  /** ...but no longer than this after the first one. */
  maxWaitMs: number;
  /**
   * Running checks of a viewed session are read at every poll for this
   * long after the head commit's checks were first read (then like
   * settled ones: a status that never resolves costs no more requests).
   */
  runningWindowMs: number;
  /** The same for a head commit without any checks (yet). */
  emptyWindowMs: number;
}

export const PR_CHECKS_TIMING = Symbol('PR_CHECKS_TIMING');

export const DEFAULT_CHECKS_TIMING: PullRequestChecksTiming = {
  pollMs: 30_000,
  staleMs: 5 * 60_000,
  debounceMs: 3_000,
  maxWaitMs: 10_000,
  runningWindowMs: 60 * 60_000,
  emptyWindowMs: 5 * 60_000,
};

/** Checks kept per pull request (the most important first). */
export const MAX_CHECKS = 200;
/** Characters of a check name kept. */
export const MAX_CHECK_NAME = 200;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Order of the states in the list: what needs attention first. */
const STATE_ORDER: PullRequestCheckState[] = [
  'failure',
  'pending',
  'cancelled',
  'success',
  'neutral',
  'skipped',
];

/** The state of a check run or commit status as the view shows it. */
export function checkState(check: CheckResult): PullRequestCheckState {
  if (check.status !== 'completed') {
    return 'pending';
  }
  const conclusion = check.conclusion ?? '';
  if (FAILED_CONCLUSIONS.has(conclusion) || conclusion === 'action_required') {
    return 'failure';
  }
  switch (conclusion) {
    case 'success':
    case 'neutral':
    case 'skipped':
      return conclusion;
    case 'cancelled':
    case 'stale':
      return 'cancelled';
    default:
      // A completed check without a known conclusion: still settling.
      return 'pending';
  }
}

/**
 * The checks of a head commit as the view shows them, sorted, at most
 * {@link MAX_CHECKS}. `readAt`: when the read started.
 */
export function checksDto(
  headSha: string,
  checks: CheckResult[],
  readAt: Date,
): PullRequestChecksDto {
  const list = checks
    .map(
      (check): PullRequestCheckDto => ({
        name: check.name.slice(0, MAX_CHECK_NAME),
        state: checkState(check),
        url: safeUrl(check.url),
      }),
    )
    .sort(
      (a, b) =>
        STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, MAX_CHECKS);
  return { headSha, readAt: readAt.toISOString(), checks: list };
}

/** Only web links reach the view (they come from GitHub apps). */
function safeUrl(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function sameChecks(
  a: PullRequestChecksDto | null,
  b: PullRequestChecksDto,
): boolean {
  return (
    a !== null &&
    a.headSha === b.headSha &&
    a.checks.length === b.checks.length &&
    a.checks.every(
      (check, index) =>
        check.name === b.checks[index].name &&
        check.state === b.checks[index].state &&
        check.url === b.checks[index].url,
    )
  );
}

interface ScheduledRead {
  timer: ReturnType<typeof setTimeout>;
  /** First and last request of this batch (ms). */
  firstAt: number;
  lastAt: number;
}

/**
 * Keeps the CI checks of open session pull requests up to date for the
 * view (`PullRequestDto.checks`), for every open pull request, with or
 * without automation: read when a pull request is created or re-read with
 * a new head commit, on webhook deliveries about checks and statuses
 * (debounced; skipped when the PR automation read them meanwhile), by the
 * PR automation's own reads, and every {@link
 * PullRequestChecksTiming.pollMs} for sessions someone looks at while
 * checks run (settled ones after {@link PullRequestChecksTiming.staleMs}).
 * Changes are published as session updates.
 */
@Injectable()
export class PullRequestChecksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PullRequestChecksService.name);
  private readonly timing: PullRequestChecksTiming;
  private readonly timers = new Map<number, ScheduledRead>();
  private readonly reading = new Map<number, Promise<void>>();
  private readonly again = new Set<number>();
  /** When the checks of a pull request's head commit were first read. */
  private readonly firstRead = new Map<
    number,
    { headSha: string; at: number }
  >();
  private subscription: Subscription | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private pausedUntil = 0;
  private stopped = false;

  constructor(
    private readonly records: SessionRepository,
    private readonly repositories: RepositoryRepository,
    private readonly sessions: SessionsService,
    private readonly sessionGit: SessionGitService,
    private readonly github: GitHubService,
    private readonly feedback: PullRequestFeedback,
    private readonly presence: ViewerPresence,
    @Optional()
    @Inject(PR_CHECKS_TIMING)
    timing?: PullRequestChecksTiming,
  ) {
    this.timing = timing ?? DEFAULT_CHECKS_TIMING;
  }

  onModuleInit(): void {
    this.subscription = this.sessionGit.refreshed$.subscribe((pull) => {
      if (this.outdated(pull)) {
        this.schedule(pull.id);
      }
    });
    if (this.timing.pollMs > 0) {
      this.pollTimer = setInterval(() => void this.poll(), this.timing.pollMs);
      this.pollTimer.unref?.();
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.subscription?.unsubscribe();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    for (const scheduled of this.timers.values()) {
      clearTimeout(scheduled.timer);
    }
    this.timers.clear();
  }

  /**
   * A webhook delivery about checks or statuses of a repository: its open
   * pull requests with these numbers (all without numbers) are re-read.
   */
  onDelivery(githubRepositoryId: number, numbers?: number[]): void {
    for (const pull of this.records.pullRequestsOfGitHubRepository(
      githubRepositoryId,
      numbers,
    )) {
      if (pull.state === 'open') {
        this.schedule(pull.id);
      }
    }
  }

  /**
   * Checks the PR automation read (starting at `readAt`) for a pull
   * request's head commit anyway: stored without another request.
   */
  store(
    pullRequestId: number,
    headSha: string,
    checks: CheckResult[],
    readAt: Date,
  ): void {
    const pull = this.records.pullRequest(pullRequestId);
    if (!pull || pull.state !== 'open' || pull.headSha !== headSha) {
      return;
    }
    this.save(pull, checksDto(headSha, checks, readAt));
  }

  /**
   * Reads a pull request's checks once requests stop coming for {@link
   * PullRequestChecksTiming.debounceMs} (at most {@link
   * PullRequestChecksTiming.maxWaitMs} after the first). The read is
   * skipped when checks read after the last request are stored by then.
   */
  schedule(pullRequestId: number): void {
    if (this.stopped) {
      return;
    }
    const now = Date.now();
    const scheduled = this.timers.get(pullRequestId);
    const firstAt = scheduled?.firstAt ?? now;
    if (scheduled) {
      clearTimeout(scheduled.timer);
    }
    const delay = Math.max(
      0,
      Math.min(this.timing.debounceMs, firstAt + this.timing.maxWaitMs - now),
    );
    const timer = setTimeout(() => {
      this.timers.delete(pullRequestId);
      void this.read(pullRequestId, now);
    }, delay);
    timer.unref?.();
    this.timers.set(pullRequestId, { timer, firstAt, lastAt: now });
  }

  /**
   * Reads the checks of a pull request's head commit from GitHub and
   * publishes them when they changed; with `after` (ms) only when the
   * stored ones were read before that. One read per pull request at a
   * time; one asked for meanwhile runs afterwards. Errors are logged.
   */
  read(pullRequestId: number, after?: number): Promise<void> {
    const running = this.reading.get(pullRequestId);
    if (running) {
      this.again.add(pullRequestId);
      return running;
    }
    const task = (async () => {
      try {
        let skipIfReadAfter = after;
        do {
          this.again.delete(pullRequestId);
          await this.readOnce(pullRequestId, skipIfReadAfter);
          skipIfReadAfter = undefined;
        } while (this.again.has(pullRequestId) && !this.stopped);
      } catch (error) {
        if (error instanceof GitHubRateLimitError) {
          this.pausedUntil = error.resetAt.getTime();
        }
        this.logger.warn(
          `Reading the checks of pull request ${pullRequestId} failed: ${errorText(error)}`,
        );
      } finally {
        this.reading.delete(pullRequestId);
      }
    })();
    this.reading.set(pullRequestId, task);
    return task;
  }

  /**
   * Viewed sessions: their open pull requests are re-read from GitHub (at
   * most once a minute, for a new head commit), and their checks when
   * {@link due}. Errors are logged.
   */
  poll(): Promise<void> {
    if (!this.polling) {
      const polling = this.pollOnce()
        .catch((error: unknown) =>
          this.logger.warn(`Polling checks failed: ${errorText(error)}`),
        )
        .finally(() => {
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
    for (const sessionId of this.presence.viewedSessions()) {
      if (this.stopped || Date.now() < this.pausedUntil) {
        return;
      }
      const session = this.records.get(sessionId);
      if (!session?.pullRequests.some((pull) => pull.state === 'open')) {
        continue;
      }
      try {
        // A new head commit (or a merge) shows up here; `refreshed$` then
        // schedules a read of its checks.
        await this.sessionGit.refreshPullRequests(sessionId);
      } catch (error) {
        // E.g. the session was deleted meanwhile.
        this.logger.warn(
          `Polling session ${sessionId} failed: ${errorText(error)}`,
        );
        continue;
      }
      if (this.stopped) {
        return;
      }
      for (const pull of this.records.get(sessionId)?.pullRequests ?? []) {
        if (this.stopped) {
          return;
        }
        if (pull.state === 'open' && this.due(pull)) {
          await this.read(pull.id);
        }
      }
    }
  }

  private async readOnce(
    pullRequestId: number,
    skipIfReadAfter?: number,
  ): Promise<void> {
    if (
      !this.github.configured ||
      this.stopped ||
      Date.now() < this.pausedUntil
    ) {
      return;
    }
    const pull = this.records.pullRequest(pullRequestId);
    if (!pull || pull.state !== 'open' || !pull.headSha) {
      return;
    }
    if (
      skipIfReadAfter !== undefined &&
      pull.checks?.headSha === pull.headSha &&
      Date.parse(pull.checks.readAt) >= skipIfReadAfter
    ) {
      // The PR automation read them after the request came.
      return;
    }
    const repository = this.repositories.get(pull.repositoryId);
    if (!repository || !isGitHubRepository(repository)) {
      return;
    }
    const headSha = pull.headSha;
    const startedAt = new Date();
    const checks = await this.feedback.checks(
      {
        installationId: repository.githubInstallationId,
        githubRepositoryId: repository.githubRepositoryId,
        fullName: `${repository.owner}/${repository.name}`,
      },
      headSha,
    );
    if (this.stopped) {
      return;
    }
    // The head may have moved meanwhile: then these are an older commit's.
    const current = this.records.pullRequest(pullRequestId);
    if (current?.state === 'open' && current.headSha === headSha) {
      this.save(current, checksDto(headSha, checks, startedAt));
    }
  }

  /**
   * Stores the checks unless newer ones of the same commit are stored (an
   * overlapping read finished first); a change is published as a session
   * update.
   */
  private save(pull: PullRequestRecord, checks: PullRequestChecksDto): void {
    const stored = pull.checks ?? null;
    if (
      stored?.headSha === checks.headSha &&
      Date.parse(stored.readAt) > Date.parse(checks.readAt)
    ) {
      return;
    }
    const first = this.firstRead.get(pull.id);
    if (first?.headSha !== checks.headSha) {
      this.firstRead.set(pull.id, {
        headSha: checks.headSha,
        at: Date.parse(checks.readAt),
      });
    }
    this.records.setPullRequestChecks(pull.id, checks);
    if (!sameChecks(stored, checks)) {
      this.sessions.publishUpdate(pull.sessionId);
    }
  }

  /** The stored checks are not those of the current head commit. */
  private outdated(pull: PullRequestRecord): boolean {
    return (
      pull.state === 'open' &&
      pull.headSha !== null &&
      pull.checks?.headSha !== pull.headSha
    );
  }

  /**
   * A viewed pull request's checks should be read again: never read for
   * the head commit; running (or none yet) and within their window; or
   * older than {@link PullRequestChecksTiming.staleMs}.
   */
  private due(pull: PullRequestRecord): boolean {
    const checks = pull.checks;
    if (!checks || this.outdated(pull)) {
      return true;
    }
    const now = Date.now();
    let first = this.firstRead.get(pull.id);
    if (first?.headSha !== checks.headSha) {
      // Not read since a restart: the window starts now.
      first = { headSha: checks.headSha, at: now };
      this.firstRead.set(pull.id, first);
    }
    const window =
      checks.checks.length === 0
        ? this.timing.emptyWindowMs
        : checks.checks.some((check) => check.state === 'pending')
          ? this.timing.runningWindowMs
          : 0;
    return (
      now - first.at < window ||
      now - Date.parse(checks.readAt) >= this.timing.staleMs
    );
  }
}
