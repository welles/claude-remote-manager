import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { requireObject, requireString } from '../common/validation';
import { GitService } from '../git/git.service';
import { githubFullName } from '../github/github.service';
import {
  isGitHubRepository,
  RepositoryCredentials,
} from '../repositories/repository-credentials';
import { RepositoryRepository } from '../repositories/repository.repository';
import { ApprovalGrants } from './approval-grants';
import { SessionCredentials } from './session-credentials';
import { SessionRepository } from './session.repository';

/** Answer to the credential helper. */
export interface GitCredentialResponse {
  username: string;
  password: string;
  expiresAt: string;
  access: 'read' | 'write';
  /** Shown by the helper on stderr (e.g. why the token is read-only). */
  note: string | null;
}

export const READ_ONLY_NOTE =
  'read-only token: pushing needs the approval of the git push command in this session';

/**
 * Installation tokens for the git credential helper of session clones.
 *
 * The helper authenticates as a session (its process token). It gets a
 * token only for a GitHub repository that is one of that session's clones,
 * scoped to exactly that repository: `contents: read` normally, and
 * `contents: write` (plus `workflows: write` if the session's commits
 * change workflow files) only while a `git push` that the user approved in
 * this session is running. Write tokens are minted for that grant and
 * revoked when it ends.
 */
@Injectable()
export class GitCredentialsService {
  private readonly logger = new Logger(GitCredentialsService.name);

  constructor(
    private readonly sessionCredentials: SessionCredentials,
    private readonly grants: ApprovalGrants,
    private readonly sessions: SessionRepository,
    private readonly repositories: RepositoryRepository,
    private readonly repositoryCredentials: RepositoryCredentials,
    private readonly git: GitService,
  ) {}

  async credentials(
    authorization: string | undefined,
    request: unknown,
  ): Promise<GitCredentialResponse> {
    const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
    const sessionId = this.sessionCredentials.resolve(token);
    if (!sessionId) {
      throw new UnauthorizedException('Unknown or expired session token');
    }
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
    const session = this.sessions.get(sessionId);
    const directory = session?.directories.find((entry) => {
      if (
        entry.kind !== 'clone' ||
        entry.state !== 'ready' ||
        !entry.repositoryId
      ) {
        return false;
      }
      const repository = this.repositories.get(entry.repositoryId);
      return (
        !!repository &&
        isGitHubRepository(repository) &&
        githubFullName(repository.cloneUrl)?.toLowerCase() ===
          path.toLowerCase()
      );
    });
    if (!session || !directory?.repositoryId) {
      this.logger.warn(
        `Session ${sessionId} asked for credentials of ${path}, which is not one of its repositories`,
      );
      throw new ForbiddenException(
        `${path} is not a GitHub repository of this session`,
      );
    }
    const repository = this.repositories.require(directory.repositoryId);
    if (!this.grants.hasPushGrant(sessionId)) {
      const read = await this.repositoryCredentials.token(repository, {
        contents: 'read',
      });
      return {
        username: 'x-access-token',
        password: read.token,
        expiresAt: read.expiresAt.toISOString(),
        access: 'read',
        note: READ_ONLY_NOTE,
      };
    }
    const head = directory.branch
      ? await this.git.localBranchCommit(directory.path, directory.branch)
      : null;
    const workflows = head
      ? await this.git.changesWorkflows(
          directory.path,
          head,
          directory.baseCommit,
        )
      : false;
    const write = await this.repositoryCredentials.token(
      repository,
      {
        contents: 'write',
        ...(workflows ? { workflows: 'write' as const } : {}),
      },
      { fresh: true },
    );
    this.grants.addToken(sessionId, write.token);
    this.logger.log(
      `Write token for ${path} handed to session ${sessionId} for an approved push`,
    );
    return {
      username: 'x-access-token',
      password: write.token,
      expiresAt: write.expiresAt.toISOString(),
      access: 'write',
      note: null,
    };
  }
}
