import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Subject } from 'rxjs';
import { cloneOf, cloneOfPull } from './session-clones';
import type {
  CreatePullRequestRequest,
  PullRequestCreator,
  PullRequestDto,
} from '@claude-remote-manager/shared-types';
import { optionalString, requireObject } from '../common/validation';
import { GitError } from '../git/git-runner';
import { GitService, isValidBranchName } from '../git/git.service';
import { KeyedMutex } from '../git/keyed-mutex';
import { GitHubApiError } from '../github/github-errors';
import {
  GitHubService,
  MERGE_METHODS,
  type MergeMethod,
} from '../github/github.service';
import {
  isGitHubRepository,
  RepositoryCredentials,
} from '../repositories/repository-credentials';
import {
  RepositoryRepository,
  type RepositoryRecord,
} from '../repositories/repository.repository';
import {
  SessionRepository,
  type PullRequestRecord,
  type SessionDirectoryRecord,
  type SessionRecord,
} from './session.repository';
import { pullRequestDto } from './pull-request-dto';

/** GitHub's limits for pull request titles and bodies. */
const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 65_536;
/** Open pull requests are re-read from GitHub at most this often. */
export const PULL_REQUEST_SYNC_MS = 60_000;

/** A session clone together with its session and repository. */
export interface SessionClone {
  session: SessionRecord;
  directory: SessionDirectoryRecord & { branch: string };
  repository: RepositoryRecord;
}

/** A reply on a review thread and/or its resolution. */
export interface ReviewThreadReplyRequest {
  /** Number of the pull request. */
  number: number;
  /** REST ID of a review comment of the thread. */
  commentId: number;
  /** The reply (Markdown); `null` or blank: no reply. */
  body: string | null;
  resolve: boolean;
  /**
   * Checked right before resolving (after the reply); `false` or an error
   * leaves the thread unresolved (`withheld`).
   */
  beforeResolve?: () => Promise<boolean>;
}

/** What {@link SessionGitService.replyToReviewThread} did. */
export interface ReviewThreadReplyOutcome {
  /** `owner/name#number`. */
  pullRequest: string;
  /** URL of the reply, `null` without one. */
  replyUrl: string | null;
  /**
   * `already`: it was resolved before; `withheld`: `beforeResolve` said
   * no; `null`: not asked to.
   */
  resolved: 'resolved' | 'already' | 'withheld' | null;
}

/** What {@link SessionGitService.mergePullRequest} did. */
export interface PullRequestMergeOutcome {
  /** `owner/name#number`. */
  pullRequest: string;
  method: MergeMethod;
  /** The head commit that was merged. */
  sha: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pushing session branches, creating pull requests and answering their
 * review threads, for one repository of a session at a time. Used by the
 * session view's buttons (the user's click is the approval) and by
 * Claude's tools `create_pull_request` and `reply_to_review_thread` (asked
 * as the session's permission mode says). Pushes and pull requests of GitHub
 * repositories use installation tokens for exactly that repository;
 * repositories registered by clone URL push with the server's own git
 * credentials; local projects have no remote to push to.
 */
/** A push of a session branch (see `SessionGitService.pushed$`). */
export interface SessionPush {
  sessionId: string;
  repositoryId: string;
  branch: string;
  commit: string;
}

@Injectable()
export class SessionGitService {
  private readonly logger = new Logger(SessionGitService.name);
  private readonly locks = new KeyedMutex();
  private readonly changes = new Subject<string>();
  private readonly closed = new Subject<PullRequestRecord>();
  private readonly refreshed = new Subject<PullRequestRecord>();
  private readonly pushed = new Subject<SessionPush>();
  /** IDs of sessions whose clones or pull requests changed. */
  readonly changes$ = this.changes.asObservable();
  /**
   * Pull requests read from GitHub as merged or closed (every time they
   * are read so; the PR automation handles each once).
   */
  readonly closed$ = this.closed.asObservable();
  /**
   * A session branch reached its remote with this commit (a push of the
   * app, or Claude's own noted afterwards).
   */
  readonly pushed$ = this.pushed.asObservable();
  /** Open pull requests just created or read from GitHub. */
  readonly refreshed$ = this.refreshed.asObservable();

  constructor(
    private readonly sessions: SessionRepository,
    private readonly repositories: RepositoryRepository,
    private readonly credentials: RepositoryCredentials,
    private readonly git: GitService,
    private readonly github: GitHubService,
  ) {}

  /** A session; 404 if it does not exist. */
  sessionRecord(sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    return session;
  }

  /**
   * A ready session clone of a repository, the one on `branch` (needed
   * when the session has several clones of it); 404/409 otherwise.
   */
  clone(
    sessionId: string,
    repositoryId: string,
    branch?: string | null,
  ): SessionClone {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    const directory = cloneOf(session.directories, repositoryId, branch);
    if (!directory || !directory.branch) {
      throw new NotFoundException(
        branch
          ? `The session has no clone of repository ${repositoryId} on ${branch}`
          : `The session has no clone of repository ${repositoryId}`,
      );
    }
    if (directory.state !== 'ready') {
      throw new ConflictException(
        `The session's clone of ${directory.repositoryName} is not available (${directory.state})`,
      );
    }
    const repository = this.repositories.get(repositoryId);
    if (!repository) {
      throw new NotFoundException(`Repository ${repositoryId} not found`);
    }
    return {
      session,
      directory: directory as SessionDirectoryRecord & { branch: string },
      repository,
    };
  }

  /**
   * Pushes the session branch of one clone (no force; with `lease`, a force
   * push over exactly that commit of the remote branch) and records the
   * pushed commit. Returns it.
   */
  async push(
    sessionId: string,
    repositoryId: string,
    branch?: string | null,
    options: { lease?: string } = {},
  ): Promise<string> {
    const clone = this.clone(sessionId, repositoryId, branch);
    const { directory, repository } = clone;
    if (repository.cloneUrl === null) {
      throw new ConflictException(
        `${repository.owner}/${repository.name} is a local project without remote; create a GitHub repository for it first`,
      );
    }
    const commit = await this.locks.run(directory.path, async () => {
      const head = await this.git.localBranchCommit(
        directory.path,
        directory.branch,
      );
      if (!head) {
        throw new ConflictException(
          `The branch ${directory.branch} has no commits yet`,
        );
      }
      try {
        return await this.git.pushSessionBranch({
          mirrorPath: repository.localPath,
          clonePath: directory.path,
          branch: directory.branch,
          baseCommit: directory.baseCommit,
          lease: options.lease,
          auth: (workflows) =>
            this.credentials.writeAuth(repository, { workflows }),
        });
      } catch (error) {
        throw this.pushError(error, directory.branch, !!options.lease);
      }
    });
    this.recordPush(sessionId, directory.position, commit);
    return commit;
  }

  /**
   * Notes the commit of the session branch on the remote after a push that
   * the app did not run itself (Claude's `git push`), from the clone's
   * remote-tracking branch. Returns whether it changed.
   */
  async notePushedCommit(
    sessionId: string,
    repositoryId: string,
    branch?: string | null,
  ): Promise<boolean> {
    let clone: SessionClone;
    try {
      clone = this.clone(sessionId, repositoryId, branch);
    } catch {
      return false;
    }
    const { directory } = clone;
    const remote = await this.git.remoteBranchCommit(
      directory.path,
      directory.branch,
    );
    if (!remote || remote === directory.pushedCommit) {
      return false;
    }
    this.recordPush(sessionId, directory.position, remote);
    return true;
  }

  /**
   * Creates a pull request from the session branch of one clone. By the
   * user (button), the branch is pushed first if GitHub does not have its
   * latest commit. By Claude (tool), it is not: Claude pushes itself (with
   * the user's credentials), and gets an error naming that if the branch is
   * missing on GitHub. An open pull request for the branch is returned
   * instead of a new one.
   */
  async createPullRequest(
    sessionId: string,
    repositoryId: string,
    request: CreatePullRequestRequest,
    createdBy: PullRequestCreator,
    branch?: string | null,
  ): Promise<PullRequestDto> {
    const body = requireObject(request);
    const title = optionalString(body, 'title', {
      maxLength: MAX_TITLE_LENGTH,
    })?.trim();
    const text = optionalString(body, 'body', { maxLength: MAX_BODY_LENGTH });
    const requestedBase = optionalString(body, 'base', {
      maxLength: 200,
    })?.trim();
    const draft = body['draft'];
    if (draft !== undefined && draft !== null && typeof draft !== 'boolean') {
      throw new BadRequestException('draft must be a boolean');
    }
    const clone = this.clone(sessionId, repositoryId, branch);
    const { session, directory, repository } = clone;
    if (!isGitHubRepository(repository)) {
      throw new ConflictException(
        `Pull requests need a repository registered from GitHub; ${repository.owner}/${repository.name} is not`,
      );
    }
    const base =
      requestedBase || directory.baseBranch || repository.defaultBranch;
    if (!base || !isValidBranchName(base)) {
      throw new BadRequestException('base is not a valid branch name');
    }
    if (base === directory.branch) {
      throw new BadRequestException(
        'The base branch must differ from the session branch',
      );
    }
    if (createdBy === 'user') {
      const head = await this.git.localBranchCommit(
        directory.path,
        directory.branch,
      );
      const remote = await this.git.remoteBranchCommit(
        directory.path,
        directory.branch,
      );
      if (head && head !== remote) {
        await this.push(sessionId, repositoryId, directory.branch);
      }
    }
    const info = await this.github.createPullRequest(
      repository.githubInstallationId,
      repository.githubRepositoryId,
      `${repository.owner}/${repository.name}`,
      {
        title: title || session.title || directory.branch,
        body: text ?? '',
        head: directory.branch,
        base,
        draft: draft === true,
      },
    );
    const saved = this.sessions.savePullRequest({
      sessionId,
      repositoryId,
      number: info.number,
      url: info.url,
      title: info.title,
      state: info.state,
      draft: info.draft,
      headBranch: info.headBranch,
      baseBranch: info.baseBranch,
      headSha: info.headSha,
      createdBy,
      openedAt: info.createdAt,
      closedAt: info.closedAt,
      mergedAt: info.mergedAt,
      syncedAt: new Date(),
    });
    this.changes.next(sessionId);
    this.refreshed.next(saved);
    return pullRequestDto(saved);
  }

  /**
   * Re-reads open pull requests of a session from GitHub when their state
   * is older than {@link PULL_REQUEST_SYNC_MS} (or always with `force`).
   * Failures are logged; the stored state stays.
   */
  async refreshPullRequests(sessionId: string, force = false): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    const now = Date.now();
    for (const pull of session.pullRequests) {
      if (
        pull.state !== 'open' ||
        (!force && now - pull.syncedAt.getTime() < PULL_REQUEST_SYNC_MS)
      ) {
        continue;
      }
      try {
        await this.refreshPullRequest(pull.id);
      } catch (error) {
        this.logger.warn(
          `Could not refresh ${pull.repositoryName}#${pull.number}: ${errorText(error)}`,
        );
      }
    }
  }

  /**
   * Reads one pull request from GitHub and stores its state (title, state,
   * head commit, ...). Reports a merge or close to {@link closed$}. Returns
   * the stored pull request, or `null` when it cannot be read from GitHub
   * (not a GitHub repository). GitHub errors are thrown.
   */
  async refreshPullRequest(
    pullRequestId: number,
  ): Promise<PullRequestRecord | null> {
    const pull = this.sessions.pullRequest(pullRequestId);
    if (!pull) {
      return null;
    }
    const repository = this.repositories.get(pull.repositoryId);
    if (!repository || !isGitHubRepository(repository)) {
      return null;
    }
    const info = await this.github.getPullRequest(
      repository.githubInstallationId,
      repository.githubRepositoryId,
      `${repository.owner}/${repository.name}`,
      pull.number,
    );
    const changed =
      pull.state !== info.state ||
      pull.title !== info.title ||
      pull.draft !== info.draft;
    // Reading the same state again does not move the session up the list.
    const touch = changed || pull.headSha !== info.headSha;
    this.sessions.updatePullRequest(
      pull.id,
      {
        title: info.title,
        state: info.state,
        draft: info.draft,
        baseBranch: info.baseBranch,
        headSha: info.headSha,
        // Kept while GitHub computes it again for the same head commit (the
        // base branch moved); unknown for a new head commit.
        ...(info.mergeConflict !== null || info.headSha !== pull.headSha
          ? { mergeConflict: info.mergeConflict }
          : {}),
        closedAt: info.closedAt,
        mergedAt: info.mergedAt,
        syncedAt: new Date(),
      },
      { touch },
    );
    const updated = this.sessions.pullRequest(pull.id) ?? null;
    if (changed) {
      this.changes.next(pull.sessionId);
    }
    if (updated && updated.state !== 'open') {
      this.closed.next(updated);
    } else if (updated) {
      this.refreshed.next(updated);
    }
    return updated;
  }

  /**
   * Replies on a review thread of one of the session's own pull requests
   * and/or resolves it (Claude's tool `reply_to_review_thread`). The thread
   * is named by any of its review comments (REST ID). Pull requests not
   * recorded for the session are refused. The thread is looked up first
   * (GraphQL), so that nothing is posted for a comment that is in no
   * thread of the pull request; the reply goes to its first comment.
   */
  async replyToReviewThread(
    sessionId: string,
    repositoryId: string,
    request: ReviewThreadReplyRequest,
  ): Promise<ReviewThreadReplyOutcome> {
    const { number, commentId, resolve } = request;
    const body = request.body?.trim() ? request.body : null;
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new BadRequestException('pull_request must be a positive number');
    }
    if (!Number.isSafeInteger(commentId) || commentId < 1) {
      throw new BadRequestException('comment_id must be a positive number');
    }
    if (body === null && !resolve) {
      throw new BadRequestException(
        'Give a reply (body), resolve the thread (resolve: true), or both',
      );
    }
    if (body !== null && body.length > MAX_BODY_LENGTH) {
      throw new BadRequestException(
        `The reply is longer than ${MAX_BODY_LENGTH} characters`,
      );
    }
    const session = this.sessionRecord(sessionId);
    const repository = this.repositories.get(repositoryId);
    if (!repository || !isGitHubRepository(repository)) {
      throw new ConflictException(
        'Review threads need a repository registered from GitHub',
      );
    }
    const fullName = `${repository.owner}/${repository.name}`;
    const pull = session.pullRequests.find(
      (entry) => entry.repositoryId === repositoryId && entry.number === number,
    );
    if (!pull) {
      const own = session.pullRequests
        .filter((entry) => entry.repositoryId === repositoryId)
        .map((entry) => `#${entry.number}`);
      throw new ForbiddenException(
        `${fullName}#${number} is not a pull request of this session (${own.length > 0 ? `its pull requests there: ${own.join(', ')}` : `it has none in ${fullName}`}); only the session's own pull requests can be answered`,
      );
    }
    const installation = repository.githubInstallationId;
    const githubId = repository.githubRepositoryId;
    // Also checks that the comment belongs to this pull request; GitHub
    // takes replies only to a thread's first comment.
    const thread = await this.github.findReviewThread(
      installation,
      githubId,
      fullName,
      number,
      commentId,
    );
    if (!thread) {
      throw new NotFoundException(
        `No review thread of ${fullName}#${number} has the comment ${commentId}`,
      );
    }
    let reply: { id: number; url: string } | null = null;
    if (body !== null) {
      try {
        reply = await this.github.replyToReviewComment(
          installation,
          githubId,
          fullName,
          number,
          thread.rootCommentId,
          body,
        );
      } catch (error) {
        if (error instanceof GitHubApiError && error.githubStatus === 404) {
          throw new NotFoundException(
            `The review comment ${thread.rootCommentId} of ${fullName}#${number} was not found (${error.message})`,
          );
        }
        throw error;
      }
    }
    if (!resolve || thread.resolved) {
      return {
        pullRequest: `${fullName}#${number}`,
        replyUrl: reply?.url ?? null,
        resolved: resolve ? 'already' : null,
      };
    }
    let verified = true;
    if (request.beforeResolve) {
      try {
        verified = await request.beforeResolve();
      } catch (error) {
        this.logger.warn(
          `Could not check again whether ${fullName}#${number} may be resolved: ${errorText(error)}`,
        );
        verified = false;
      }
    }
    if (!verified) {
      return {
        pullRequest: `${fullName}#${number}`,
        replyUrl: reply?.url ?? null,
        resolved: 'withheld',
      };
    }
    try {
      await this.github.resolveReviewThread(installation, githubId, thread.id);
    } catch (error) {
      if (reply) {
        throw new BadGatewayException(
          `Replied (${reply.url}), but the thread was not resolved: ${errorText(error)}`,
        );
      }
      throw error;
    }
    return {
      pullRequest: `${fullName}#${number}`,
      replyUrl: reply?.url ?? null,
      resolved: 'resolved',
    };
  }

  /**
   * Merges one of the session's own open pull requests (Claude's tool
   * `merge_pull_request`) with an installation token for that repository:
   * exactly the head commit `sha` (the one a check saw), else the head
   * GitHub reports now. With `method`, only that way; else as automerge
   * does (rebase, else squash, a merge commit only when neither is
   * possible). Pull requests not recorded for the session are refused. The
   * merge is recorded right away (notification, autoclose).
   */
  async mergePullRequest(
    sessionId: string,
    repositoryId: string,
    number: number,
    options: { sha: string | null; method: MergeMethod | null },
  ): Promise<PullRequestMergeOutcome> {
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new BadRequestException('pull_request must be a positive number');
    }
    const session = this.sessionRecord(sessionId);
    const repository = this.repositories.get(repositoryId);
    if (!repository || !isGitHubRepository(repository)) {
      throw new ConflictException(
        'Merging needs a repository registered from GitHub',
      );
    }
    const fullName = `${repository.owner}/${repository.name}`;
    const pull = session.pullRequests.find(
      (entry) => entry.repositoryId === repositoryId && entry.number === number,
    );
    if (!pull) {
      const own = session.pullRequests
        .filter((entry) => entry.repositoryId === repositoryId)
        .map((entry) => `#${entry.number}`);
      throw new ForbiddenException(
        `${fullName}#${number} is not a pull request of this session (${own.length > 0 ? `its pull requests there: ${own.join(', ')}` : `it has none in ${fullName}`}); only the session's own pull requests can be merged`,
      );
    }
    const current = options.sha ? pull : await this.refreshPullRequest(pull.id);
    if (!current || current.state !== 'open') {
      throw new ConflictException(
        `${fullName}#${number} is ${current?.state ?? 'not readable'}, not open`,
      );
    }
    const sha = options.sha ?? current.headSha;
    if (!sha) {
      throw new ConflictException(
        `The head commit of ${fullName}#${number} is not known`,
      );
    }
    const method = await this.github.mergePullRequest(
      repository.githubInstallationId,
      repository.githubRepositoryId,
      fullName,
      number,
      sha,
      options.method ? [options.method] : MERGE_METHODS,
    );
    try {
      await this.refreshPullRequest(pull.id);
    } catch (error) {
      // Merged all the same; polling records it later.
      this.logger.warn(
        `Could not read ${fullName}#${number} after merging it: ${errorText(error)}`,
      );
    }
    return { pullRequest: `${fullName}#${number}`, method, sha };
  }

  /**
   * Whether resolving the review thread of `commentId` may run unasked
   * during an Autofix run that started at `runStartedAt` (the owner's
   * decision): only when, in this run and after the thread's last comment
   * not written by the app, a push to the session branch made the pull
   * request's current head what it is. That is a push since the comment in
   * this run, not proof that the thread was fixed. Returns the head commit
   * it checked, `null` when it may not. Everything comes from
   * GitHub, nothing from the clone or the tool call: the head commit from
   * the pull request, the push and its time from the repository activity
   * (GitHub's own record), the comment times from GraphQL. `false` when
   * anything is missing; errors are thrown (the caller asks then).
   */
  async mayResolveUnasked(
    sessionId: string,
    repositoryId: string,
    number: number,
    commentId: number,
    runStartedAt: Date,
  ): Promise<string | null> {
    const session = this.sessionRecord(sessionId);
    const pull = session.pullRequests.find(
      (entry) => entry.repositoryId === repositoryId && entry.number === number,
    );
    const directory = pull ? cloneOfPull(session.directories, pull) : undefined;
    const repository = this.repositories.get(repositoryId);
    if (
      !pull ||
      !directory?.branch ||
      pull.headBranch !== directory.branch ||
      !repository ||
      !isGitHubRepository(repository) ||
      !Number.isFinite(runStartedAt.getTime())
    ) {
      return null;
    }
    const fullName = `${repository.owner}/${repository.name}`;
    const installation = repository.githubInstallationId;
    const githubId = repository.githubRepositoryId;
    const thread = await this.github.findReviewThread(
      installation,
      githubId,
      fullName,
      number,
      commentId,
    );
    if (!thread?.lastOtherCommentAt) {
      return null;
    }
    const info = await this.github.getPullRequest(
      installation,
      githubId,
      fullName,
      number,
    );
    if (
      info.state !== 'open' ||
      info.headBranch !== directory.branch ||
      !info.headSha
    ) {
      return null;
    }
    const push = await this.github.latestBranchPush(
      installation,
      githubId,
      fullName,
      info.headBranch,
    );
    return push !== null &&
      push.after === info.headSha &&
      push.at.getTime() > thread.lastOtherCommentAt.getTime() &&
      push.at.getTime() > runStartedAt.getTime()
      ? info.headSha
      : null;
  }

  // -------------------------------------------------------------------------

  private recordPush(sessionId: string, position: number, commit: string) {
    this.sessions.updateDirectory(sessionId, position, {
      pushedCommit: commit,
      pushedAt: new Date(),
    });
    this.changes.next(sessionId);
    const directory = this.sessions
      .get(sessionId)
      ?.directories.find((entry) => entry.position === position);
    if (directory?.repositoryId && directory.branch) {
      this.pushed.next({
        sessionId,
        repositoryId: directory.repositoryId,
        branch: directory.branch,
        commit,
      });
    }
  }

  /** A failed push as a clear HTTP error. */
  private pushError(error: unknown, branch: string, lease = false): Error {
    if (!(error instanceof GitError)) {
      return error instanceof Error ? error : new Error(String(error));
    }
    if (lease && /stale info|\[rejected\]/i.test(error.stderr)) {
      return new ConflictException(
        `The remote branch ${branch} changed since the session clone last fetched it; fetch it and look at the new commits first`,
      );
    }
    if (/non-fast-forward|fetch first|\[rejected\]/i.test(error.stderr)) {
      return new ConflictException(
        `The remote branch ${branch} has commits the session clone does not have; fetch and merge them first`,
      );
    }
    if (
      /workflow/i.test(error.stderr) &&
      /permission|scope/i.test(error.stderr)
    ) {
      return new ConflictException(
        `GitHub refused to update workflow files: ${error.message}`,
      );
    }
    return new BadGatewayException(`Push failed: ${error.message}`);
  }
}
