import {
  isRepositoryFullName,
  MAX_ADDITION_REASON_LENGTH,
  type RepositoryAdditionCall,
} from '@claude-remote-manager/shared-types';
import { Injectable } from '@nestjs/common';
import { InvalidCloneUrlError, parseCloneUrl } from '../git/clone-url';
import { isValidBranchName } from '../git/git.service';
import {
  LOCAL_OWNER,
  RepositoriesService,
} from '../repositories/repositories.service';
import type { SessionRecord } from '../sessions/session.repository';

/** An `add_repository` call that is refused before the user is asked. */
export class AdditionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdditionRefused';
  }
}

/** What an approved `add_repository` call adds. */
export type AdditionTarget =
  | { kind: 'registered'; repositoryId: string }
  | { kind: 'github'; githubRepositoryId: number }
  | { kind: 'url'; cloneUrl: string };

/** A checked `add_repository` call: what the approval shows and adds. */
export interface ResolvedAddition {
  call: RepositoryAdditionCall;
  target: AdditionTarget;
  baseBranch: string | null;
}

const text = (input: Record<string, unknown>, name: string): string | null =>
  typeof input[name] === 'string' && (input[name] as string).trim()
    ? (input[name] as string).trim()
    : null;

/**
 * Checks Claude's `add_repository` calls against what the new-session form
 * allows: a registered repository or local project (by `owner/name`), a
 * repository of the GitHub App's installations (by `owner/name`), or a clone
 * URL under the form's rules (https, ssh, scp-like). Local paths and
 * `file://` URLs are refused: Claude names no paths on this machine. A
 * repository that is part of the session already is refused with a clear
 * message. Nothing is registered or cloned here; that happens when the
 * tool runs (after the user approved the call, where Claude Code asked).
 */
@Injectable()
export class RepositoryAdditions {
  constructor(private readonly repositories: RepositoriesService) {}

  async resolve(
    session: SessionRecord,
    input: Record<string, unknown>,
  ): Promise<ResolvedAddition> {
    const name = text(input, 'repository');
    const url = text(input, 'url');
    const reason = text(input, 'reason');
    const baseBranch = text(input, 'base_branch');
    if (!reason) {
      throw new AdditionRefused(
        'Say why you need the repository (reason); the user sees it with the request.',
      );
    }
    if (reason.length > MAX_ADDITION_REASON_LENGTH) {
      throw new AdditionRefused(
        `The reason is longer than ${MAX_ADDITION_REASON_LENGTH} characters.`,
      );
    }
    if ((name === null) === (url === null)) {
      throw new AdditionRefused(
        'Name the repository either by owner/name (repository) or by clone URL (url), not both.',
      );
    }
    if (baseBranch !== null && !isValidBranchName(baseBranch)) {
      throw new AdditionRefused(`${baseBranch} is not a valid branch name.`);
    }
    const resolved = name ? await this.byName(name) : this.byUrl(url as string);
    const fullName = resolved.call.repository.toLowerCase();
    const present = session.directories.find(
      (directory) =>
        directory.repositoryName?.toLowerCase() === fullName ||
        (resolved.target.kind === 'registered' &&
          directory.repositoryId === resolved.target.repositoryId),
    );
    if (present) {
      throw new AdditionRefused(
        present.addition && present.addition.state !== 'ready'
          ? `${present.repositoryName} is already being added to this session (${present.addition.state}); the user can retry or remove it in the session details.`
          : `${present.repositoryName} is already part of this session: its clone is ${present.path}.`,
      );
    }
    return {
      ...resolved,
      baseBranch,
      call: { ...resolved.call, baseBranch, reason },
    };
  }

  /**
   * Registers the target of an approved call if the app does not know it
   * yet (like choosing it in the form does) and returns its repository ID.
   */
  async register(target: AdditionTarget): Promise<string> {
    switch (target.kind) {
      case 'registered':
        return target.repositoryId;
      case 'github':
        return (
          await this.repositories.registerFromGitHub(target.githubRepositoryId)
        ).id;
      case 'url':
        return (await this.repositories.register({ cloneUrl: target.cloneUrl }))
          .id;
    }
  }

  private async byName(
    name: string,
  ): Promise<Omit<ResolvedAddition, 'baseBranch'>> {
    if (!isRepositoryFullName(name)) {
      throw new AdditionRefused(
        `${name} is not a repository name: use owner/name (a local project is local/PROJECT).`,
      );
    }
    const registered = this.repositories.findByName(name);
    if (registered) {
      const local = registered.cloneUrl === null;
      return {
        target: { kind: 'registered', repositoryId: registered.id },
        call: {
          source: local
            ? 'project'
            : registered.githubRepositoryId !== null
              ? 'github'
              : 'url',
          repository: `${registered.owner}/${registered.name}`,
          url: registered.cloneUrl,
          registered: true,
          baseBranch: null,
          defaultBranch: registered.defaultBranch,
          reason: '',
        },
      };
    }
    if (name.toLowerCase().startsWith(`${LOCAL_OWNER}/`)) {
      throw new AdditionRefused(
        `There is no local project ${name}. Local projects are created by the user.`,
      );
    }
    let found: Awaited<ReturnType<RepositoriesService['findGitHubRepository']>>;
    try {
      found = await this.repositories.findGitHubRepository(name);
    } catch (error) {
      throw new AdditionRefused(
        `GitHub could not be asked whether the app can access ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!found) {
      throw new AdditionRefused(
        this.repositories.githubConfigured
          ? `${name} is neither registered in the session manager nor accessible to its GitHub App. The user can install the app on it or register it.`
          : `${name} is not registered in the session manager, and GitHub is not configured. Name a registered repository or give a clone URL.`,
      );
    }
    return {
      target: { kind: 'github', githubRepositoryId: found.id },
      call: {
        source: 'github',
        repository: found.fullName,
        url: `https://github.com/${found.fullName}.git`,
        registered: false,
        baseBranch: null,
        defaultBranch: found.defaultBranch,
        reason: '',
      },
    };
  }

  private byUrl(input: string): Omit<ResolvedAddition, 'baseBranch'> {
    let parsed;
    try {
      parsed = parseCloneUrl(input);
    } catch (error) {
      if (error instanceof InvalidCloneUrlError) {
        throw new AdditionRefused(
          `The clone URL is not accepted: ${error.message}`,
        );
      }
      throw error;
    }
    if (parsed.url.startsWith('/')) {
      throw new AdditionRefused(
        'Local paths cannot be added: name a registered repository, a local project (local/PROJECT) or a remote clone URL.',
      );
    }
    const registered = this.repositories.findByCloneUrl(parsed.url);
    if (registered) {
      return this.registeredCall(registered.id, parsed.url);
    }
    const sameName = this.repositories.findByName(
      `${parsed.owner}/${parsed.name}`,
    );
    if (sameName) {
      throw new AdditionRefused(
        `${sameName.owner}/${sameName.name} is registered with another URL (${sameName.cloneUrl ?? 'no remote'}); name it by owner/name instead.`,
      );
    }
    return {
      target: { kind: 'url', cloneUrl: parsed.url },
      call: {
        source: 'url',
        repository: `${parsed.owner}/${parsed.name}`,
        url: parsed.url,
        registered: false,
        baseBranch: null,
        defaultBranch: null,
        reason: '',
      },
    };
  }

  private registeredCall(
    repositoryId: string,
    url: string,
  ): Omit<ResolvedAddition, 'baseBranch'> {
    const record = this.repositories.require(repositoryId);
    return {
      target: { kind: 'registered', repositoryId },
      call: {
        source: record.githubRepositoryId !== null ? 'github' : 'url',
        repository: `${record.owner}/${record.name}`,
        url,
        registered: true,
        baseBranch: null,
        defaultBranch: record.defaultBranch,
        reason: '',
      },
    };
  }
}
