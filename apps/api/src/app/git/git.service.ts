import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  GIT_NETWORK_TIMEOUT_MS,
  GitError,
  retryOnLockContention,
  runGit,
} from './git-runner';
import { KeyedMutex } from './keyed-mutex';

/** A worktree as `git worktree list` reports it (without the bare clone). */
export interface GitWorktree {
  path: string;
  /** Commit checked out; `null` for an unborn branch. */
  head: string | null;
  /** Short branch name, `null` when detached. */
  branch: string | null;
  locked: boolean;
  /** Git considers the worktree prunable (e.g. its directory is missing). */
  prunable: boolean;
}

export interface AddWorktreeOptions {
  /** Shared clone (bare repository). */
  repoPath: string;
  /** New directory for the worktree; must not exist. */
  path: string;
  /** New branch, e.g. `claude/<slug>`; must not exist. */
  branch: string;
  /** Commit the branch starts at; `null` for an empty repository. */
  baseCommit: string | null;
  /** Why the worktree is locked, e.g. the session it belongs to. */
  lockReason: string;
}

export interface UpdateResult {
  /** Default branch of the remote; `null` if the remote has no HEAD. */
  defaultBranch: string | null;
  /** Whether this call cloned the repository. */
  cloned: boolean;
}

/**
 * Fetch remote branches (pruning deleted ones) and tags. Tags are shared by
 * all worktrees; the remote's tags win over local tags of the same name, and
 * local-only tags are kept (`--prune` does not apply to `--tags`).
 */
const FETCH_OPTIONS = ['--prune', '--tags', '--force', '--quiet'];

/** Remote branches as fetched: `refs/remotes/origin/<branch>`. */
const REMOTE_PREFIX = 'refs/remotes/origin/';

/**
 * Branch names accepted from users (base branches): git's rules for ref
 * names, restricted to common characters.
 */
const BRANCH_PATTERN =
  /^(?![-./])(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/+-]{1,200}(?<![./])$/;

export function isValidBranchName(name: string): boolean {
  return BRANCH_PATTERN.test(name) && !name.includes('@{');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Parses `git worktree list --porcelain`, without the bare entry. */
export function parseWorktreeList(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  for (const block of output.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length === 0 || !lines[0].startsWith('worktree ')) {
      continue;
    }
    if (lines.includes('bare')) {
      continue;
    }
    const field = (name: string) =>
      lines.find((line) => line === name || line.startsWith(`${name} `));
    const value = (name: string) => field(name)?.slice(name.length + 1);
    const head = value('HEAD');
    const branch = value('branch');
    worktrees.push({
      path: lines[0].slice('worktree '.length),
      head: head && !/^0+$/.test(head) ? head : null,
      branch: branch?.startsWith('refs/heads/')
        ? branch.slice('refs/heads/'.length)
        : null,
      locked: field('locked') !== undefined,
      prunable: field('prunable') !== undefined,
    });
  }
  return worktrees;
}

/**
 * Git operations on the shared clones and the session worktrees.
 *
 * Every repository has one shared clone: a bare repository whose remote
 * branches are fetched into `refs/remotes/origin/*` only. Nobody works in
 * it, so a fetch never touches a branch that a worktree has checked out, and
 * there is no working tree, index or HEAD in it that a session could
 * change. Each session gets a linked worktree on its own branch.
 *
 * Commands that write to a shared clone (clone, fetch, adding and removing
 * worktrees, deleting branches) run one at a time per clone; clones of
 * different repositories do not wait for each other. Concurrent updates of
 * the same clone share one fetch.
 */
@Injectable()
export class GitService {
  private readonly locks = new KeyedMutex();
  private readonly updates = new Map<string, Promise<UpdateResult>>();

  /** Whether a clone or fetch of this clone is running or queued. */
  isUpdating(repoPath: string): boolean {
    return this.updates.has(repoPath);
  }

  /**
   * Clones the repository if `repoPath` does not exist yet, otherwise
   * fetches. Joins an update of the same clone that has not finished yet.
   */
  update(repoPath: string, url: string): Promise<UpdateResult> {
    let update = this.updates.get(repoPath);
    if (!update) {
      update = this.locks
        .run(repoPath, async () => {
          const cloned = !(await this.isBareRepository(repoPath));
          if (cloned) {
            await this.cloneLocked(repoPath, url);
          } else {
            await this.checkOrigin(repoPath, url);
            await retryOnLockContention(() =>
              this.git(repoPath, ['fetch', ...FETCH_OPTIONS, 'origin'], {
                timeoutMs: GIT_NETWORK_TIMEOUT_MS,
              }),
            );
          }
          return {
            defaultBranch: await this.refreshDefaultBranch(repoPath),
            cloned,
          };
        })
        .finally(() => this.updates.delete(repoPath));
      this.updates.set(repoPath, update);
    }
    return update;
  }

  /** Remote branches of the clone as last fetched, sorted. */
  async remoteBranches(repoPath: string): Promise<string[]> {
    const output = await this.git(repoPath, [
      'for-each-ref',
      '--format=%(refname)',
      REMOTE_PREFIX,
    ]);
    return output
      .split('\n')
      .filter((ref) => ref.startsWith(REMOTE_PREFIX))
      .map((ref) => ref.slice(REMOTE_PREFIX.length))
      .filter((branch) => branch !== 'HEAD')
      .sort();
  }

  /** Default branch as last fetched; `null` if unknown. */
  async defaultBranch(repoPath: string): Promise<string | null> {
    try {
      const ref = (
        await this.git(repoPath, [
          'symbolic-ref',
          '--quiet',
          `${REMOTE_PREFIX}HEAD`,
        ])
      ).trim();
      return ref.startsWith(REMOTE_PREFIX)
        ? ref.slice(REMOTE_PREFIX.length)
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Commit of a remote branch as last fetched, or `null` if the branch does
   * not exist. Throws for names that are not valid branch names.
   */
  async remoteBranchCommit(
    repoPath: string,
    branch: string,
  ): Promise<string | null> {
    if (!isValidBranchName(branch)) {
      throw new Error(`"${branch}" is not a valid branch name`);
    }
    try {
      return (
        await this.git(repoPath, [
          'rev-parse',
          '--verify',
          '--quiet',
          `${REMOTE_PREFIX}${branch}^{commit}`,
        ])
      ).trim();
    } catch {
      return null;
    }
  }

  /** Whether the remote had no branches at all when last fetched. */
  async isEmpty(repoPath: string): Promise<boolean> {
    return (await this.remoteBranches(repoPath)).length === 0;
  }

  /**
   * Creates a locked worktree on a new branch. Locking keeps
   * `git worktree prune` (also run by `git gc`) from dropping it while its
   * volume is unavailable, and `git worktree remove` without the app from
   * removing it. On failure, a branch the call created is deleted again.
   */
  async addWorktree(options: AddWorktreeOptions): Promise<void> {
    const { repoPath, path, branch, baseCommit, lockReason } = options;
    await this.locks.run(repoPath, async () => {
      if (await this.branchExistsLocked(repoPath, branch)) {
        throw new Error(`Branch ${branch} already exists`);
      }
      await mkdir(dirname(path), { recursive: true });
      const args = ['worktree', 'add', '--lock', '--reason', lockReason];
      try {
        await retryOnLockContention(() =>
          this.git(
            repoPath,
            baseCommit
              ? [...args, '-b', branch, '--', path, baseCommit]
              : [...args, '--orphan', '-b', branch, '--', path],
          ),
        );
      } catch (error) {
        const registered = (await this.listWorktreesLocked(repoPath)).some(
          (worktree) => worktree.path === path,
        );
        if (registered) {
          await this.git(repoPath, ['worktree', 'unlock', '--', path]).catch(
            () => undefined,
          );
          await this.git(repoPath, [
            'worktree',
            'remove',
            '--force',
            '--',
            path,
          ]).catch(() => undefined);
        }
        if (await this.branchExistsLocked(repoPath, branch)) {
          await this.git(repoPath, ['branch', '-D', '--', branch]).catch(
            () => undefined,
          );
        }
        throw error;
      }
    });
  }

  /**
   * Removes a worktree of the clone. Without `force`, git refuses if it has
   * modified or untracked files. A worktree whose directory is already gone
   * is unregistered. Does nothing if the path is neither registered nor on
   * disk; refuses to touch a directory that is not a worktree of the clone.
   */
  async removeWorktree(
    repoPath: string,
    path: string,
    { force = false }: { force?: boolean } = {},
  ): Promise<void> {
    await this.locks.run(repoPath, async () => {
      const worktree = (await this.listWorktreesLocked(repoPath)).find(
        (entry) => entry.path === path,
      );
      if (!worktree) {
        if (await exists(path)) {
          throw new Error(`${path} is not a worktree of ${repoPath}`);
        }
        return;
      }
      if (worktree.locked) {
        await this.git(repoPath, ['worktree', 'unlock', '--', path]);
      }
      try {
        if (await exists(path)) {
          await retryOnLockContention(() =>
            this.git(repoPath, [
              'worktree',
              'remove',
              ...(force ? ['--force'] : []),
              '--',
              path,
            ]),
          );
        } else {
          // Only unlocked worktrees with missing directories are pruned:
          // this one and none of the (locked) session worktrees.
          await this.git(repoPath, ['worktree', 'prune']);
        }
      } catch (error) {
        if (worktree.locked && (await exists(path))) {
          await this.git(repoPath, [
            'worktree',
            'lock',
            '--reason',
            'restored after a failed removal',
            '--',
            path,
          ]).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  /**
   * Deletes a local branch, also if it is not merged. Git refuses to delete
   * a branch that a worktree has checked out.
   */
  async deleteBranch(repoPath: string, branch: string): Promise<void> {
    if (!isValidBranchName(branch)) {
      throw new Error(`"${branch}" is not a valid branch name`);
    }
    await this.locks.run(repoPath, () =>
      retryOnLockContention(() =>
        this.git(repoPath, ['branch', '-D', '--', branch]),
      ),
    );
  }

  async branchExists(repoPath: string, branch: string): Promise<boolean> {
    return this.branchExistsLocked(repoPath, branch);
  }

  /** Worktrees registered in the clone. */
  listWorktrees(repoPath: string): Promise<GitWorktree[]> {
    return this.listWorktreesLocked(repoPath);
  }

  /** Whether `path` is a bare repository (and not inside another one). */
  async isBareRepository(path: string): Promise<boolean> {
    if (!(await exists(path))) {
      return false;
    }
    try {
      return (
        (await this.git(path, ['rev-parse', '--is-bare-repository'])).trim() ===
        'true'
      );
    } catch {
      return false;
    }
  }

  /**
   * Creates a new project directory with an empty repository on `main`.
   * Fails if the directory exists.
   */
  async initProject(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await mkdir(path);
    try {
      await runGit(['init', '--quiet', '--initial-branch=main'], { cwd: path });
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }

  // -------------------------------------------------------------------------

  /** git on a shared clone, addressed with `--git-dir` (no discovery). */
  private git(
    repoPath: string,
    args: string[],
    options: { timeoutMs?: number } = {},
  ): Promise<string> {
    return runGit([`--git-dir=${repoPath}`, ...args], options);
  }

  /**
   * Clones into a temporary directory next to the target and renames it,
   * so an interrupted clone never looks like a finished one. Leftovers of
   * earlier interrupted clones of the same repository are removed.
   */
  private async cloneLocked(repoPath: string, url: string): Promise<void> {
    if (await exists(repoPath)) {
      throw new Error(
        `${repoPath} exists but is not a bare repository; move it away first`,
      );
    }
    const parent = dirname(repoPath);
    const prefix = `.${basename(repoPath)}.clone-`;
    await mkdir(parent, { recursive: true });
    for (const entry of await readdir(parent)) {
      if (entry.startsWith(prefix)) {
        await rm(join(parent, entry), { recursive: true, force: true });
      }
    }
    const temporary = join(parent, prefix + randomBytes(4).toString('hex'));
    try {
      await runGit(['init', '--quiet', '--bare', '--', temporary]);
      const config = (name: string, value: string) =>
        this.git(temporary, ['config', '--', name, value]);
      await config('remote.origin.url', url);
      await config(
        'remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/*',
      );
      // Reflogs for all refs, as in non-bare repositories: lets commits of
      // deleted or reset session branches be recovered.
      await config('core.logAllRefUpdates', 'true');
      await this.git(temporary, ['fetch', ...FETCH_OPTIONS, 'origin'], {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      });
      await rename(temporary, repoPath);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  /** Refuses to fetch into a clone of another remote. */
  private async checkOrigin(repoPath: string, url: string): Promise<void> {
    let origin = '';
    try {
      origin = (
        await this.git(repoPath, ['config', '--get', 'remote.origin.url'])
      ).trim();
    } catch {
      // no origin configured
    }
    if (origin !== url) {
      throw new Error(
        `${repoPath} is a clone of ${origin || 'an unknown remote'}, not of ${url}`,
      );
    }
  }

  /**
   * Updates `refs/remotes/origin/HEAD` from the remote (its default branch
   * may have changed) and returns the branch.
   */
  private async refreshDefaultBranch(repoPath: string): Promise<string | null> {
    try {
      await this.git(repoPath, ['remote', 'set-head', 'origin', '--auto'], {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      });
    } catch (error) {
      if (!(error instanceof GitError)) {
        throw error;
      }
      // Empty remote: no HEAD to follow. Keep what is known.
    }
    return this.defaultBranch(repoPath);
  }

  private async branchExistsLocked(
    repoPath: string,
    branch: string,
  ): Promise<boolean> {
    try {
      await this.git(repoPath, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  private async listWorktreesLocked(repoPath: string): Promise<GitWorktree[]> {
    return parseWorktreeList(
      await this.git(repoPath, ['worktree', 'list', '--porcelain']),
    );
  }
}
