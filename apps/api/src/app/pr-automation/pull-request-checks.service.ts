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
  /** Webhook deliveries within this time cause one read. */
  debounceMs: number;
}

export const PR_CHECKS_TIMING = Symbol('PR_CHECKS_TIMING');

export const DEFAULT_CHECKS_TIMING: PullRequestChecksTiming = {
  pollMs: 30_000,
  staleMs: 5 * 60_000,
  debounceMs: 3_000,
};

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

/** The checks of a head commit as the view shows them, sorted. */
export function checksDto(
  headSha: string,
  checks: CheckResult[],
  readAt: Date,
): PullRequestChecksDto {
  const list = checks
    .map(
      (check): PullRequestCheckDto => ({
        name: check.name,
        state: checkState(check),
        url: safeUrl(check.url),
      }),
    )
    .sort(
      (a, b) =>
        STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
        a.name.localeCompare(b.name),
    );
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

/**
 * Keeps the CI checks of open session pull requests up to date for the
 * view (`PullRequestDto.checks`), for every open pull request, with or
 * without automation: read when a pull request is created or re-read with
 * a new head commit, on webhook deliveries about checks and statuses, by
 * the PR automation's own reads, and every {@link
 * PullRequestChecksTiming.pollMs} for sessions someone looks at while
 * checks run (settled ones after {@link PullRequestChecksTiming.staleMs}).
 * Changes are published as session updates.
 */
@Injectable()
export class PullRequestChecksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PullRequestChecksService.name);
  private readonly timing: PullRequestChecksTiming;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly reading = new Map<number, Promise<void>>();
  private readonly again = new Set<number>();
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
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
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
   * Checks the PR automation read for a pull request's head commit anyway:
   * stored without another request.
   */
  store(pullRequestId: number, headSha: string, checks: CheckResult[]): void {
    const pull = this.records.pullRequest(pullRequestId);
    if (!pull || pull.state !== 'open' || pull.headSha !== headSha) {
      return;
    }
    this.save(pull, checksDto(headSha, checks, new Date()));
  }

  /** Reads a pull request's checks after a short delay (calls join). */
  schedule(pullRequestId: number, delayMs = this.timing.debounceMs): void {
    if (this.stopped || this.timers.has(pullRequestId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(pullRequestId);
      void this.read(pullRequestId);
    }, delayMs);
    timer.unref?.();
    this.timers.set(pullRequestId, timer);
  }

  /**
   * Reads the checks of a pull request's head commit from GitHub and
   * publishes them when they changed. One read per pull request at a time;
   * one asked for meanwhile runs afterwards. Errors are logged.
   */
  read(pullRequestId: number): Promise<void> {
    const running = this.reading.get(pullRequestId);
    if (running) {
      this.again.add(pullRequestId);
      return running;
    }
    const task = (async () => {
      try {
        do {
          this.again.delete(pullRequestId);
          await this.readOnce(pullRequestId);
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
   * most once a minute, for a new head commit), and checks that run, were
   * never read or are older than {@link PullRequestChecksTiming.staleMs}
   * are read again.
   */
  poll(): Promise<void> {
    if (!this.polling) {
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
    for (const sessionId of this.presence.viewedSessions()) {
      if (this.stopped || Date.now() < this.pausedUntil) {
        return;
      }
      const session = this.records.get(sessionId);
      if (!session?.pullRequests.some((pull) => pull.state === 'open')) {
        continue;
      }
      // A new head commit (or a merge) shows up here; `refreshed$` then
      // schedules a read of its checks.
      await this.sessionGit.refreshPullRequests(sessionId);
      for (const pull of this.records.get(sessionId)?.pullRequests ?? []) {
        if (pull.state === 'open' && this.due(pull)) {
          await this.read(pull.id);
        }
      }
    }
  }

  private async readOnce(pullRequestId: number): Promise<void> {
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
    const repository = this.repositories.get(pull.repositoryId);
    if (!repository || !isGitHubRepository(repository)) {
      return;
    }
    const headSha = pull.headSha;
    const checks = await this.feedback.checks(
      {
        installationId: repository.githubInstallationId,
        githubRepositoryId: repository.githubRepositoryId,
        fullName: `${repository.owner}/${repository.name}`,
      },
      headSha,
    );
    // The head may have moved meanwhile: then these are an older commit's.
    const current = this.records.pullRequest(pullRequestId);
    if (current?.state === 'open' && current.headSha === headSha) {
      this.save(current, checksDto(headSha, checks, new Date()));
    }
  }

  /** Stores the checks; a change is published as a session update. */
  private save(pull: PullRequestRecord, checks: PullRequestChecksDto): void {
    const changed = !sameChecks(pull.checks ?? null, checks);
    this.records.setPullRequestChecks(pull.id, checks);
    if (changed) {
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

  /** A viewed pull request's checks should be read again. */
  private due(pull: PullRequestRecord): boolean {
    const checks = pull.checks;
    return (
      this.outdated(pull) ||
      !checks ||
      checks.checks.length === 0 ||
      checks.checks.some((check) => check.state === 'pending') ||
      Date.now() - Date.parse(checks.readAt) >= this.timing.staleMs
    );
  }
}
