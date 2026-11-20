import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  RemoteBranch,
  RemoteBranchChoice,
  RemoteBranchOutcome,
} from '@claude-remote-manager/shared-types';
import { requireObject } from '../common/validation';
import { GitService } from '../git/git.service';
import { GitHubService } from '../github/github.service';
import { RepositoriesService } from '../repositories/repositories.service';
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** A clone of the session whose branch may be on a remote. */
interface Candidate {
  directory: SessionDirectoryRecord & { branch: string };
  repository: RepositoryRecord & { cloneUrl: string };
}

/**
 * The session branches on the remotes of a session's repositories: what
 * deleting them would lose (read from the freshly fetched mirror, and for
 * GitHub repositories from the pull requests of the branch), and deleting
 * them for the cleanup and archiving. A branch with an open pull request is
 * never deleted (that would close the pull request); one with commits that
 * no other branch, tag or merged pull request has only after the owner
 * accepted losing them. Clones already removed count too: a session
 * closed after its pull request was merged has its branch left on GitHub.
 */
@Injectable()
export class SessionRemoteBranches {
  constructor(
    private readonly repositories: RepositoriesService,
    private readonly repositoryRecords: RepositoryRepository,
    private readonly credentials: RepositoryCredentials,
    private readonly git: GitService,
    private readonly github: GitHubService,
    private readonly sessions: SessionRepository,
  ) {}

  /** The session's branches that exist on their remotes now. */
  async describe(record: SessionRecord): Promise<RemoteBranch[]> {
    const described = await Promise.all(
      this.candidates(record).map((candidate) => this.describeOne(candidate)),
    );
    return described.filter((entry): entry is RemoteBranch => entry !== null);
  }

  /**
   * Deletes the chosen branches, each checked again right before: kept if
   * it got an open pull request or would lose commits not accepted.
   */
  async delete(
    record: SessionRecord,
    choices: RemoteBranchChoice[],
  ): Promise<RemoteBranchOutcome[]> {
    const outcomes: RemoteBranchOutcome[] = [];
    const candidates = this.candidates(record);
    for (const choice of choices) {
      const candidate = candidates.find(
        (entry) => entry.directory.position === choice.position,
      );
      if (!candidate) {
        outcomes.push({
          position: choice.position,
          name: `Directory ${choice.position}`,
          branch: '',
          result: 'failed',
          message: 'The session has no branch on a remote there',
        });
        continue;
      }
      outcomes.push(await this.deleteOne(record.id, candidate, choice));
    }
    return outcomes;
  }

  // -------------------------------------------------------------------------

  /** Clones (existing or removed) of repositories with a remote. */
  private candidates(record: SessionRecord): Candidate[] {
    const found: Candidate[] = [];
    for (const directory of record.directories) {
      if (
        directory.kind !== 'clone' ||
        !directory.branch ||
        !directory.repositoryId ||
        (directory.state !== 'ready' && directory.state !== 'removed')
      ) {
        continue;
      }
      const repository = this.repositoryRecords.get(directory.repositoryId);
      if (!repository || repository.cloneUrl === null) {
        continue;
      }
      found.push({
        directory: directory as Candidate['directory'],
        repository: repository as Candidate['repository'],
      });
    }
    return found;
  }

  /** `null` when the branch is not on the remote. */
  private async describeOne({
    directory,
    repository,
  }: Candidate): Promise<RemoteBranch | null> {
    const base: RemoteBranch = {
      position: directory.position,
      name: `${repository.owner}/${repository.name}`,
      branch: directory.branch,
      commit: null,
      unmergedCount: 0,
      mergedBy: null,
      pullRequestsChecked: false,
      safe: false,
      blocked: null,
      error: null,
    };
    let mirror: RepositoryRecord;
    try {
      mirror = await this.repositories.update(repository.id);
    } catch (error) {
      return {
        ...base,
        error: `The remote could not be read: ${errorText(error)}`,
      };
    }
    const commit = await this.git.branchCommit(
      mirror.localPath,
      directory.branch,
    );
    if (!commit) {
      return null;
    }
    base.commit = commit;
    try {
      base.unmergedCount = await this.git.commitsOnlyOn(
        mirror.localPath,
        directory.branch,
        commit,
      );
    } catch (error) {
      return {
        ...base,
        error: `What the branch holds could not be read: ${errorText(error)}`,
      };
    }
    if (isGitHubRepository(mirror)) {
      try {
        const pulls = await this.github.pullRequestsFrom(
          mirror.githubInstallationId,
          mirror.githubRepositoryId,
          base.name,
          directory.branch,
        );
        const open = pulls.filter((pull) => pull.state === 'open');
        if (open.length > 0) {
          base.blocked = `${open.length === 1 ? 'Pull request' : 'Pull requests'} ${open.map((pull) => `#${pull.number}`).join(', ')} ${open.length === 1 ? 'is' : 'are'} open; deleting the branch would close ${open.length === 1 ? 'it' : 'them'}`;
        }
        base.pullRequestsChecked = true;
        base.mergedBy =
          pulls.find(
            (pull) => pull.state === 'merged' && pull.headSha === commit,
          )?.number ?? null;
      } catch (error) {
        return {
          ...base,
          error: `Its pull requests could not be read: ${errorText(error)}`,
        };
      }
    }
    if (base.mergedBy !== null) {
      base.unmergedCount = 0;
    }
    // Without GitHub, open pull (merge) requests are unknown: never
    // offered checked.
    base.safe =
      base.blocked === null &&
      base.unmergedCount === 0 &&
      base.pullRequestsChecked;
    return base;
  }

  private async deleteOne(
    sessionId: string,
    candidate: Candidate,
    choice: RemoteBranchChoice,
  ): Promise<RemoteBranchOutcome> {
    const { directory, repository } = candidate;
    const name = `${repository.owner}/${repository.name}`;
    const outcome = (
      result: RemoteBranchOutcome['result'],
      message: string,
    ): RemoteBranchOutcome => ({
      position: directory.position,
      name,
      branch: directory.branch,
      result,
      message,
    });
    let state: RemoteBranch | null;
    try {
      state = await this.describeOne(candidate);
    } catch (error) {
      return outcome(
        'failed',
        `${directory.branch} could not be checked (${errorText(error)}); kept`,
      );
    }
    if (!state) {
      return outcome('gone', `${directory.branch} is not on the remote`);
    }
    if (state.error || !state.commit) {
      return outcome(
        'failed',
        `${directory.branch} kept: ${state.error ?? 'its commit is unknown'}`,
      );
    }
    if (state.blocked) {
      return outcome('kept', `${directory.branch} kept: ${state.blocked}`);
    }
    if (state.unmergedCount > 0 && choice.acceptLoss !== true) {
      return outcome(
        'kept',
        `${directory.branch} kept: it has ${plural(state.unmergedCount, 'commit', 'commits')} no other branch has`,
      );
    }
    try {
      await this.git.deleteRemoteBranch(
        repository.localPath,
        directory.branch,
        state.commit,
        () =>
          this.credentials.writeAuth(
            this.repositoryRecords.get(repository.id) ?? repository,
            { workflows: false },
          ),
      );
    } catch (error) {
      return outcome(
        'failed',
        `${directory.branch} could not be deleted on the remote (${errorText(error)})`,
      );
    }
    let note = '';
    if (state.unmergedCount > 0) {
      // Its commits are on the remote no more: a clone still there must
      // count them as lost again.
      this.sessions.updateDirectory(sessionId, directory.position, {
        pushedCommit: null,
        pushedAt: null,
      });
      if (directory.state === 'ready') {
        try {
          await this.git.forgetRemoteBranch(directory.path, directory.branch);
        } catch (error) {
          note = `; the clone still counts its commits as pushed (${errorText(error)})`;
        }
      }
    }
    return outcome(
      'deleted',
      `deleted ${directory.branch} on the remote${
        state.mergedBy !== null
          ? ` (merged by #${state.mergedBy})`
          : state.unmergedCount > 0
            ? ` (lost ${plural(state.unmergedCount, 'commit', 'commits')})`
            : ''
      }${note}`,
    );
  }
}

/** Parses the `remoteBranches` of a cleanup or archive request. */
export function parseRemoteBranchChoices(value: unknown): RemoteBranchChoice[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 20) {
    throw new BadRequestException(
      'remoteBranches must be a list of branch choices',
    );
  }
  const seen = new Set<number>();
  return value.map((item: unknown) => {
    const entry = requireObject(item);
    const position = entry['position'];
    if (
      typeof position !== 'number' ||
      !Number.isInteger(position) ||
      position < 0 ||
      seen.has(position)
    ) {
      throw new BadRequestException(
        'remoteBranches: position must be a directory position',
      );
    }
    seen.add(position);
    if (
      entry['acceptLoss'] !== undefined &&
      typeof entry['acceptLoss'] !== 'boolean'
    ) {
      throw new BadRequestException(
        'remoteBranches: acceptLoss must be a boolean',
      );
    }
    return { position, acceptLoss: entry['acceptLoss'] === true };
  });
}
