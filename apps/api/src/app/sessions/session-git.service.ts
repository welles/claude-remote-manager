import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Subject } from 'rxjs';
import type {
  CreatePullRequestRequest,
  PullRequestCreator,
  PullRequestDto,
} from '@claude-remote-manager/shared-types';
import { optionalString, requireObject } from '../common/validation';
import { GitError } from '../git/git-runner';
import { GitService, isValidBranchName } from '../git/git.service';
import { KeyedMutex } from '../git/keyed-mutex';
import { GitHubService } from '../github/github.service';
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pushing session branches and creating pull requests, for one repository
 * of a session at a time. Used by the session view's buttons (the user's
 * click is the approval) and by Claude's `create_pull_request` tool (after
 * the user approved that call). Pushes and pull requests of GitHub
 * repositories use installation tokens for exactly that repository;
 * repositories registered by clone URL push with the server's own git
 * credentials; local projects have no remote to push to.
 */
@Injectable()
export class SessionGitService {
  private readonly logger = new Logger(SessionGitService.name);
  private readonly locks = new KeyedMutex();
  private readonly changes = new Subject<string>();
  /** IDs of sessions whose clones or pull requests changed. */
  readonly changes$ = this.changes.asObservable();

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

  /** A ready session clone of a repository; 404/409 otherwise. */
  clone(sessionId: string, repositoryId: string): SessionClone {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    const directory = session.directories.find(
      (entry) => entry.kind === 'clone' && entry.repositoryId === repositoryId,
    );
    if (!directory || !directory.branch) {
      throw new NotFoundException(
        `The session has no clone of repository ${repositoryId}`,
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
   * Pushes the session branch of one clone (no force) and records the
   * pushed commit. Returns it.
   */
  async push(sessionId: string, repositoryId: string): Promise<string> {
    const clone = this.clone(sessionId, repositoryId);
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
          auth: (workflows) =>
            this.credentials.writeAuth(repository, { workflows }),
        });
      } catch (error) {
        throw this.pushError(error, directory.branch);
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
  ): Promise<boolean> {
    let clone: SessionClone;
    try {
      clone = this.clone(sessionId, repositoryId);
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
   * latest commit. By Claude (tool), it is not: Claude pushes itself, with
   * its own approval, and gets an error naming that if the branch is
   * missing on GitHub. An open pull request for the branch is returned
   * instead of a new one.
   */
  async createPullRequest(
    sessionId: string,
    repositoryId: string,
    request: CreatePullRequestRequest,
    createdBy: PullRequestCreator,
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
    const clone = this.clone(sessionId, repositoryId);
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
        await this.push(sessionId, repositoryId);
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
      createdBy,
      openedAt: info.createdAt,
      closedAt: info.closedAt,
      mergedAt: info.mergedAt,
      syncedAt: new Date(),
    });
    this.changes.next(sessionId);
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
    let changed = false;
    for (const pull of session.pullRequests) {
      if (
        pull.state !== 'open' ||
        (!force && now - pull.syncedAt.getTime() < PULL_REQUEST_SYNC_MS)
      ) {
        continue;
      }
      const repository = this.repositories.get(pull.repositoryId);
      if (!repository || !isGitHubRepository(repository)) {
        continue;
      }
      try {
        const info = await this.github.getPullRequest(
          repository.githubInstallationId,
          repository.githubRepositoryId,
          `${repository.owner}/${repository.name}`,
          pull.number,
        );
        this.sessions.updatePullRequest(pull.id, {
          title: info.title,
          state: info.state,
          draft: info.draft,
          baseBranch: info.baseBranch,
          closedAt: info.closedAt,
          mergedAt: info.mergedAt,
          syncedAt: new Date(),
        });
        changed = true;
      } catch (error) {
        this.logger.warn(
          `Could not refresh ${pull.repositoryName}#${pull.number}: ${errorText(error)}`,
        );
      }
    }
    if (changed) {
      this.changes.next(sessionId);
    }
  }

  // -------------------------------------------------------------------------

  private recordPush(sessionId: string, position: number, commit: string) {
    this.sessions.updateDirectory(sessionId, position, {
      pushedCommit: commit,
      pushedAt: new Date(),
    });
    this.changes.next(sessionId);
  }

  /** A failed push as a clear HTTP error. */
  private pushError(error: unknown, branch: string): Error {
    if (!(error instanceof GitError)) {
      return error instanceof Error ? error : new Error(String(error));
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
