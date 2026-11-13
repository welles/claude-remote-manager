import { Injectable, Logger } from '@nestjs/common';
import { githubTokenAuth, type GitAuth } from '../git/git-auth';
import {
  GitHubApiError,
  GitHubNotConfiguredError,
} from '../github/github-errors';
import { GitHubService } from '../github/github.service';
import type {
  GitHubPermissionSet,
  InstallationToken,
} from '../github/installation-tokens';
import {
  RepositoryRepository,
  type RepositoryRecord,
} from './repository.repository';

/** A repository registered from GitHub (with installation and ID). */
export function isGitHubRepository(
  record: RepositoryRecord,
): record is RepositoryRecord & {
  githubRepositoryId: number;
  githubInstallationId: number;
} {
  return (
    record.githubRepositoryId !== null && record.githubInstallationId !== null
  );
}

/**
 * Credentials of the API's own git commands for a repository: for GitHub
 * repositories an installation token for exactly that repository with the
 * permissions of the operation; for repositories registered by plain clone
 * URL none (git uses the API's environment: SSH key, credential helper).
 *
 * If the installation of a repository changed (the app was reinstalled,
 * the repository moved to another account), the current installation is
 * looked up once and stored.
 */
@Injectable()
export class RepositoryCredentials {
  private readonly logger = new Logger(RepositoryCredentials.name);

  constructor(
    private readonly github: GitHubService,
    private readonly repositories: RepositoryRepository,
  ) {}

  /** Token for a GitHub repository; throws for other repositories. */
  async token(
    record: RepositoryRecord,
    permissions: GitHubPermissionSet,
    { fresh = false }: { fresh?: boolean } = {},
  ): Promise<InstallationToken> {
    if (!isGitHubRepository(record)) {
      throw new Error(
        `${record.owner}/${record.name} is not a GitHub repository`,
      );
    }
    if (!this.github.configured) {
      throw new GitHubNotConfiguredError(
        `${record.owner}/${record.name} was registered from GitHub, but ${this.github.credentials.problem}`,
      );
    }
    try {
      return await this.github.repositoryToken(
        record.githubInstallationId,
        record.githubRepositoryId,
        permissions,
        fresh,
      );
    } catch (error) {
      // 404: installation gone; 422: repository not in the installation.
      if (
        !(error instanceof GitHubApiError) ||
        ![404, 422].includes(error.githubStatus)
      ) {
        throw error;
      }
      const installationId = await this.github.installationFor(
        record.owner,
        record.name,
      );
      if (!installationId || installationId === record.githubInstallationId) {
        throw new GitHubApiError(
          error.githubStatus,
          `The GitHub App has no access to ${record.owner}/${record.name} anymore; install it for this repository again`,
        );
      }
      this.logger.log(
        `${record.owner}/${record.name} moved to installation ${installationId}`,
      );
      this.github.tokens.invalidate(record.githubInstallationId);
      this.repositories.update(record.id, {
        githubInstallationId: installationId,
      });
      return this.github.repositoryToken(
        installationId,
        record.githubRepositoryId,
        permissions,
        fresh,
      );
    }
  }

  /**
   * Auth for fetching (`contents: read`); `null` for repositories without
   * GitHub registration.
   */
  async readAuth(record: RepositoryRecord): Promise<GitAuth | null> {
    if (!isGitHubRepository(record)) {
      return null;
    }
    return githubTokenAuth(
      (await this.token(record, { contents: 'read' })).token,
    );
  }

  /**
   * Auth for pushing (`contents: write`, plus `workflows: write` when the
   * pushed commits change workflow files, which GitHub requires).
   */
  async writeAuth(
    record: RepositoryRecord,
    { workflows }: { workflows: boolean },
  ): Promise<GitAuth | null> {
    if (!isGitHubRepository(record)) {
      return null;
    }
    return githubTokenAuth(
      (
        await this.token(record, {
          contents: 'write',
          ...(workflows ? { workflows: 'write' as const } : {}),
        })
      ).token,
    );
  }
}
