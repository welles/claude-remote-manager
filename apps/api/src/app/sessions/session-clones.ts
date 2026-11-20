import { BadRequestException } from '@nestjs/common';
import { isRetiredClone } from '@claude-remote-manager/shared-types';
import type { SessionDirectoryRecord } from './session.repository';

/**
 * A session can have several clones of one repository, each on a branch of
 * its own (`claude/<slug>`, then `claude/<slug>-2`, … from `add_branch`),
 * one per pull request worked on in parallel. These find the clone meant.
 */

/** The session's clones of a repository, the first one first. */
export function clonesOf(
  directories: readonly SessionDirectoryRecord[],
  repositoryId: string,
): SessionDirectoryRecord[] {
  return directories
    .filter(
      (directory) =>
        directory.kind === 'clone' && directory.repositoryId === repositoryId,
    )
    .sort((a, b) => a.position - b.position);
}

/**
 * The clone of a repository on `branch`; without a branch the only clone
 * that is not retired (removed after its pull request; when all are, the
 * only one at all). Several such clones and no branch: a 400 naming the
 * branches.
 */
export function cloneOf(
  directories: readonly SessionDirectoryRecord[],
  repositoryId: string,
  branch?: string | null,
): SessionDirectoryRecord | undefined {
  const all = clonesOf(directories, repositoryId);
  if (branch) {
    return all.find((directory) => directory.branch === branch);
  }
  const current = all.filter((directory) => !isRetiredClone(directory));
  const clones = current.length > 0 ? current : all;
  if (clones.length > 1) {
    throw new BadRequestException(
      `The session has several clones of ${clones[0].repositoryName ?? 'the repository'} (branches ${clones
        .map((directory) => directory.branch)
        .join(', ')}); name the branch`,
    );
  }
  return clones[0];
}

/**
 * The clone a pull request comes from: the clone on its head branch, else
 * (a pull request from elsewhere) the repository's only clone that is not
 * retired.
 */
export function cloneOfPull(
  directories: readonly SessionDirectoryRecord[],
  pull: { repositoryId: string; headBranch: string },
): SessionDirectoryRecord | undefined {
  const clones = clonesOf(directories, pull.repositoryId);
  const current = clones.filter((directory) => !isRetiredClone(directory));
  return (
    clones.find((directory) => directory.branch === pull.headBranch) ??
    (current.length === 1 ? current[0] : undefined)
  );
}

/**
 * Which clones the app removes (`retired`) once their pull request is
 * merged or closed (the other conditions, e.g. another directory left:
 * `extraCloneOf` in the PR automation). Owner's decision (2026-11-20):
 * every clone, also a repository's only one (the session's first, or one
 * added with `add_repository`), not only further clones from
 * `add_branch`. The one place to change that rule.
 */
export function retiresAfterPullRequest(
  directories: readonly SessionDirectoryRecord[],
  directory: SessionDirectoryRecord,
): boolean {
  void directories;
  void directory;
  return true;
}

/**
 * The `branch` query parameter of the routes per clone: which of the
 * session's clones of the repository (needed when it has several).
 */
export function branchParam(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
