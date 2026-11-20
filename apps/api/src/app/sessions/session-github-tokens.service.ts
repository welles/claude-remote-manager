import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  optionalString,
  requireObject,
  requireString,
} from '../common/validation';
import { GitService } from '../git/git.service';
import { GitHubService, githubFullName } from '../github/github.service';
import type {
  GitHubPermissionSet,
  InstallationToken,
} from '../github/installation-tokens';
import {
  isGitHubRepository,
  RepositoryCredentials,
} from '../repositories/repository-credentials';
import {
  RepositoryRepository,
  type RepositoryRecord,
} from '../repositories/repository.repository';
import { SessionRepository, type SessionRecord } from './session.repository';
import { SessionTokens } from './session-tokens';

/** Answer to the token helper. */
export interface SessionGitHubToken {
  username: 'x-access-token';
  token: string;
  expiresAt: string;
  /** owner/name of the repositories the token can access. */
  repositories: string[];
}

/** What a token for `git` may do: push and fetch the one repository. */
export const GIT_PERMISSIONS: GitHubPermissionSet = { contents: 'write' };

/**
 * What a token for `gh` may do: read the session's repositories with their
 * pull requests, issues, checks and Actions runs. Read only, so that
 * Claude cannot approve, merge or resolve review threads (the automerge
 * gate), close issues or change settings with it.
 */
export const GH_PERMISSIONS: GitHubPermissionSet = {
  metadata: 'read',
  contents: 'read',
  pull_requests: 'read',
  issues: 'read',
  checks: 'read',
  statuses: 'read',
  actions: 'read',
};

/** A handed-out token is reused at most this long ... */
export const SESSION_TOKEN_REUSE_MS = 10 * 60_000;
/** ... and only while it is valid at least this much longer. */
const MIN_REMAINING_MS = 5 * 60_000;

type GitHubRepository = RepositoryRecord & {
  githubRepositoryId: number;
  githubInstallationId: number;
};

/**
 * Installation tokens for the processes of a session, in the container
 * (`separate-users`), where the session user has no GitHub credentials of
 * its own: `git` gets one through a credential helper, `gh` through a
 * wrapper (`assets/crm-github.cjs`).
 *
 * The helper authenticates as the session (its process token). A token
 * covers only GitHub repositories that are ready clones of that session:
 * - `git`: exactly the repository of the remote, `contents: write`
 *   (plus `workflows: write` if the session branch changes workflow
 *   files). Whether a `git push` runs is decided by the session's
 *   permission mode like any command; the approval dialog shows what it
 *   would update.
 * - `gh`: all the session's repositories of one installation, read only
 *   ({@link GH_PERMISSIONS}).
 *
 * Tokens are minted for the session alone (never the API's cached ones),
 * reused for at most ten minutes and all revoked when the session's
 * process ends.
 *
 * Limits: the `git` token's `contents: write` can also merge pull
 * requests and push to any branch, so the automerge gate holds only with
 * branch protection on GitHub. All sessions run as one OS user, so a
 * session can read another running session's process token (its
 * environment) and get tokens for that session's repositories.
 */
@Injectable()
export class SessionGitHubTokensService {
  private readonly logger = new Logger(SessionGitHubTokensService.name);
  /** Tokens to reuse, by session and kind. */
  private readonly handedOut = new Map<
    string,
    Map<string, { minted: number; token: Promise<InstallationToken> }>
  >();
  /** Every token minted for a session's process, to revoke at its end. */
  private readonly minted = new Map<string, Promise<InstallationToken>[]>();

  constructor(
    readonly processTokens: SessionTokens,
    private readonly sessions: SessionRepository,
    private readonly repositories: RepositoryRepository,
    private readonly repositoryCredentials: RepositoryCredentials,
    private readonly github: GitHubService,
    private readonly git: GitService,
  ) {}

  /** Clock, replaceable in tests. */
  now: () => number = Date.now;

  /** Token for `git` (credential helper): one repository, write. */
  async forGit(
    authorization: string | undefined,
    request: unknown,
  ): Promise<SessionGitHubToken> {
    const { session, processToken } = this.authenticate(authorization);
    const body = requireObject(request);
    const protocol = requireString(body, 'protocol', { maxLength: 20 });
    const host = requireString(body, 'host', { maxLength: 255 });
    const path = requireString(body, 'path', { maxLength: 300 })
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/, '');
    if (protocol !== 'https' || host.toLowerCase() !== 'github.com') {
      throw new NotFoundException(
        'Credentials are only provided for https://github.com',
      );
    }
    // Several clones of one repository (`add_branch`): one token for all.
    const matching = this.clones(session).filter(
      ({ repository }) =>
        githubFullName(repository.cloneUrl)?.toLowerCase() ===
        path.toLowerCase(),
    );
    const found = matching[0];
    if (!found) {
      this.logger.warn(
        `Session ${session.id} asked for a token for ${JSON.stringify(path)}, which is not one of its repositories`,
      );
      throw new ForbiddenException(
        `${path} is not a GitHub repository of this session`,
      );
    }
    const { repository } = found;
    let workflows = false;
    for (const { directory } of matching) {
      const head = directory.branch
        ? await this.git
            .localBranchCommit(directory.path, directory.branch)
            .catch(() => null)
        : null;
      if (
        head &&
        (await this.git
          .changesWorkflows(directory.path, head, directory.baseCommit)
          .catch(() => false))
      ) {
        workflows = true;
        break;
      }
    }
    const permissions: GitHubPermissionSet = {
      ...GIT_PERMISSIONS,
      ...(workflows ? { workflows: 'write' as const } : {}),
    };
    const token = await this.handOut(
      session.id,
      processToken,
      `git|${repository.id}|${workflows}`,
      () =>
        this.repositoryCredentials.token(repository, permissions, {
          fresh: true,
        }),
    );
    return this.answer(token, [repository]);
  }

  /**
   * Token for `gh`: read access to the session's repositories in the
   * installation of `repository` (owner/name, the remote of the working
   * directory), or of its first GitHub repository.
   */
  async forGh(
    authorization: string | undefined,
    request: unknown,
  ): Promise<SessionGitHubToken> {
    const { session, processToken } = this.authenticate(authorization);
    const body = requireObject(request);
    const name = optionalString(body, 'repository', { maxLength: 300 })
      ?.trim()
      .toLowerCase();
    const repositories = this.clones(session).map(
      ({ repository }) => repository,
    );
    if (repositories.length === 0) {
      throw new ForbiddenException(
        'This session has no GitHub repositories, so gh gets no token',
      );
    }
    const chosen =
      (name &&
        repositories.find(
          (repository) =>
            githubFullName(repository.cloneUrl)?.toLowerCase() === name,
        )) ||
      repositories[0];
    const covered = repositories.filter(
      (repository) =>
        repository.githubInstallationId === chosen.githubInstallationId,
    );
    const ids = [
      ...new Set(covered.map((repository) => repository.githubRepositoryId)),
    ].sort((a, b) => a - b);
    const token = await this.handOut(
      session.id,
      processToken,
      `gh|${chosen.githubInstallationId}|${ids.join(',')}`,
      () => {
        if (!this.github.configured) {
          throw new ForbiddenException('The GitHub App is not configured');
        }
        return this.github.tokens.get({
          installationId: chosen.githubInstallationId,
          repositoryIds: ids,
          permissions: GH_PERMISSIONS,
          fresh: true,
        });
      },
    );
    return this.answer(token, covered);
  }

  /** The session's process ended: its tokens stop working. */
  release(sessionId: string): void {
    this.processTokens.revoke(sessionId);
    this.handedOut.delete(sessionId);
    const minted = this.minted.get(sessionId) ?? [];
    this.minted.delete(sessionId);
    for (const token of minted) {
      void token
        .then((entry) => this.github.tokens.revoke(entry.token))
        .catch(() => undefined);
    }
  }

  private authenticate(authorization: string | undefined): {
    session: SessionRecord;
    processToken: string;
  } {
    const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
    const sessionId = this.processTokens.resolve(token);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || !token) {
      throw new UnauthorizedException('Unknown or expired session token');
    }
    return { session, processToken: token };
  }

  /** Whether the process token still belongs to the session. */
  private stillValid(sessionId: string, processToken: string): boolean {
    return this.processTokens.resolve(processToken) === sessionId;
  }

  /** Ready clones of the session's GitHub repositories. */
  private clones(session: SessionRecord): {
    directory: SessionRecord['directories'][number];
    repository: GitHubRepository;
  }[] {
    return session.directories.flatMap((directory) => {
      if (
        directory.kind !== 'clone' ||
        directory.state !== 'ready' ||
        !directory.repositoryId
      ) {
        return [];
      }
      const repository = this.repositories.get(directory.repositoryId);
      return repository && isGitHubRepository(repository)
        ? [{ directory, repository }]
        : [];
    });
  }

  private async handOut(
    sessionId: string,
    processToken: string,
    key: string,
    mint: () => Promise<InstallationToken>,
  ): Promise<InstallationToken> {
    // The process may have ended while the request waited (e.g. for git).
    if (!this.stillValid(sessionId, processToken)) {
      throw new UnauthorizedException('Unknown or expired session token');
    }
    let tokens = this.handedOut.get(sessionId);
    if (!tokens) {
      tokens = new Map();
      this.handedOut.set(sessionId, tokens);
    }
    const cached = tokens.get(key);
    if (cached && this.now() - cached.minted < SESSION_TOKEN_REUSE_MS) {
      const token = await cached.token.catch(() => null);
      if (token && token.expiresAt.getTime() - this.now() > MIN_REMAINING_MS) {
        return token;
      }
    }
    const minting = mint();
    const entry = { minted: this.now(), token: minting };
    tokens.set(key, entry);
    let all = this.minted.get(sessionId);
    if (!all) {
      all = [];
      this.minted.set(sessionId, all);
    }
    all.push(minting);
    try {
      const token = await minting;
      if (!this.stillValid(sessionId, processToken)) {
        // Released while minting: the process is gone.
        void this.github.tokens.revoke(token.token).catch(() => undefined);
        throw new UnauthorizedException('The session process ended');
      }
      this.logger.log(`GitHub token (${key}) handed to session ${sessionId}`);
      return token;
    } catch (error) {
      if (tokens.get(key) === entry) {
        tokens.delete(key);
      }
      throw error;
    }
  }

  private answer(
    token: InstallationToken,
    repositories: RepositoryRecord[],
  ): SessionGitHubToken {
    return {
      username: 'x-access-token',
      token: token.token,
      expiresAt: token.expiresAt.toISOString(),
      repositories: repositories.map(
        (repository) => `${repository.owner}/${repository.name}`,
      ),
    };
  }
}
