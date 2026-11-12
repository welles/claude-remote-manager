import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  GIT_NETWORK_TIMEOUT_MS,
  retryOnLockContention,
  runGit,
} from './git-runner';
import { KeyedMutex } from './keyed-mutex';

export interface MirrorState {
  /**
   * Default branch: the remote's HEAD, or `main` for a local project;
   * `null` for an empty remote.
   */
  defaultBranch: string | null;
  /** Whether this call created the mirror. */
  created: boolean;
}

export interface CreateSessionCloneOptions {
  mirrorPath: string;
  /** New directory for the clone; must not exist. */
  path: string;
  /**
   * URL `origin` of the clone points to: the real remote. `null` for a
   * local project, whose clones keep the mirror as `origin`.
   */
  remoteUrl: string | null;
  /** New session branch, e.g. `claude/<slug>`. */
  branch: string;
  /** Commit the branch starts at; `null` for an unborn (orphan) branch. */
  baseCommit: string | null;
}

/**
 * The mirror keeps the remote's branches as its own `refs/heads/*`, so a
 * plain local clone of it sees them as `origin/*`. Deleted remote branches
 * are pruned. Tags of the remote overwrite local ones of the same name.
 */
const MIRROR_FETCH_REFSPEC = '+refs/heads/*:refs/heads/*';
const FETCH_OPTIONS = ['--prune', '--tags', '--force', '--quiet'];

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

/** `ref: refs/heads/main\tHEAD` from `git ls-remote --symref`. */
export function parseRemoteHead(output: string): string | null {
  const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(output);
  return match ? match[1] : null;
}

/**
 * Git operations on the mirrors and the session clones.
 *
 * A mirror is a bare repository per registered repository; it is cloned
 * once from the remote and then only fetched (local projects have no
 * remote: their mirror is the project's main repository). Nobody works in
 * it. Each session gets its own complete clone of it: `git clone --local`
 * hardlinks the objects (no alternates, so the mirror's gc cannot affect
 * the clone), and refs, stash, tags, config, hooks and index belong to the
 * clone alone. Removing a session clone is deleting its directory.
 *
 * Commands that read or write a whole mirror (clone, fetch, cloning a
 * session clone from it, integrating a session branch) run one at a time
 * per mirror; mirrors of different repositories do not wait for each
 * other. Concurrent updates of the same mirror share one fetch.
 */
@Injectable()
export class GitService {
  private readonly locks = new KeyedMutex();
  private readonly updates = new Map<string, Promise<MirrorState>>();

  /** Whether a clone or fetch of this mirror is running or queued. */
  isUpdating(mirrorPath: string): boolean {
    return this.updates.has(mirrorPath);
  }

  /**
   * Creates the mirror if it does not exist yet (clone from `remoteUrl`, or
   * an empty repository on `main` for a local project), otherwise fetches
   * (nothing to do for a local project). Joins an update of the same
   * mirror that has not finished yet.
   */
  updateMirror(
    mirrorPath: string,
    remoteUrl: string | null,
  ): Promise<MirrorState> {
    let update = this.updates.get(mirrorPath);
    if (!update) {
      update = this.locks
        .run(mirrorPath, async () => {
          const created = !(await this.isBareRepository(mirrorPath));
          if (remoteUrl === null) {
            if (created) {
              await this.initLocalMirror(mirrorPath);
            }
            return {
              defaultBranch: await this.headBranch(mirrorPath),
              created,
            };
          }
          if (created) {
            await this.cloneMirror(mirrorPath, remoteUrl);
          } else {
            await this.checkOrigin(mirrorPath, remoteUrl);
            await retryOnLockContention(() =>
              this.git(mirrorPath, ['fetch', ...FETCH_OPTIONS, 'origin'], {
                timeoutMs: GIT_NETWORK_TIMEOUT_MS,
              }),
            );
          }
          return {
            defaultBranch: await this.followRemoteHead(mirrorPath),
            created,
          };
        })
        .finally(() => this.updates.delete(mirrorPath));
      this.updates.set(mirrorPath, update);
    }
    return update;
  }

  /** Branches of the mirror, sorted. */
  async branches(mirrorPath: string): Promise<string[]> {
    const output = await this.git(mirrorPath, [
      'for-each-ref',
      '--format=%(refname:lstrip=2)',
      'refs/heads/',
    ]);
    return output.split('\n').filter(Boolean).sort();
  }

  /**
   * Commit of a branch of the mirror, or `null` if it does not exist (or is
   * unborn). Throws for names that are not valid branch names.
   */
  async branchCommit(
    mirrorPath: string,
    branch: string,
  ): Promise<string | null> {
    if (!isValidBranchName(branch)) {
      throw new Error(`"${branch}" is not a valid branch name`);
    }
    try {
      return (
        await this.git(mirrorPath, [
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/heads/${branch}^{commit}`,
        ])
      ).trim();
    } catch {
      return null;
    }
  }

  /** Whether the mirror has no branches (empty remote or new project). */
  async isEmpty(mirrorPath: string): Promise<boolean> {
    return (await this.branches(mirrorPath)).length === 0;
  }

  /**
   * Creates a session clone: a local clone of the mirror with hardlinked
   * objects, `origin` pointing to the real remote (or staying the mirror
   * for local projects), and the new session branch checked out at the base
   * commit, without upstream. Removes the directory again on failure.
   */
  async createSessionClone(options: CreateSessionCloneOptions): Promise<void> {
    const { mirrorPath, path, remoteUrl, branch, baseCommit } = options;
    if (!isValidBranchName(branch)) {
      throw new Error(`"${branch}" is not a valid branch name`);
    }
    if (await exists(path)) {
      throw new Error(`${path} already exists`);
    }
    await mkdir(dirname(path), { recursive: true });
    try {
      await this.locks.run(mirrorPath, () =>
        runGit([
          'clone',
          '--local',
          '--no-checkout',
          '--quiet',
          '--',
          mirrorPath,
          path,
        ]),
      );
      const inClone = (args: string[]) => runGit(args, { cwd: path });
      if (remoteUrl !== null) {
        await inClone(['config', '--', 'remote.origin.url', remoteUrl]);
      }
      if (baseCommit) {
        // The clone created a local branch for origin/HEAD; the session
        // works on its own branch only.
        const initial = await this.currentBranch(path);
        await inClone([
          'checkout',
          '--quiet',
          '--no-track',
          '-b',
          branch,
          baseCommit,
        ]);
        if (initial && initial !== branch) {
          await inClone(['branch', '--quiet', '-D', '--', initial]);
        }
      } else {
        // Empty repository or project: the first commit starts the branch.
        await inClone(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      }
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Removes a session clone. It is independent of the mirror and of other
   * sessions, so this is deleting its directory.
   */
  async removeSessionClone(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  /**
   * Brings a session branch into a local project: fast-forwards
   * `targetBranch` of the mirror (creating it if unborn) to `sourceBranch`
   * of the session clone. Git refuses if that is not a fast-forward; merge
   * the target into the session branch first. Repositories with a remote
   * are integrated by pushing to the remote instead (their mirror follows
   * the remote). Returns the new commit of the target branch.
   */
  async fastForwardMirror(options: {
    mirrorPath: string;
    clonePath: string;
    sourceBranch: string;
    targetBranch: string;
  }): Promise<string> {
    const { mirrorPath, clonePath, sourceBranch, targetBranch } = options;
    for (const branch of [sourceBranch, targetBranch]) {
      if (!isValidBranchName(branch)) {
        throw new Error(`"${branch}" is not a valid branch name`);
      }
    }
    return this.locks.run(mirrorPath, async () => {
      if (await this.hasRemote(mirrorPath)) {
        throw new Error(
          'This repository has a remote; integrate the session branch by pushing to it',
        );
      }
      await this.git(mirrorPath, [
        'fetch',
        '--no-tags',
        '--quiet',
        '--',
        clonePath,
        // Without "+": only a fast-forward is accepted.
        `refs/heads/${sourceBranch}:refs/heads/${targetBranch}`,
      ]);
      return (
        await this.git(mirrorPath, ['rev-parse', `refs/heads/${targetBranch}`])
      ).trim();
    });
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

  /** Branch checked out in a (non-bare) repository, `null` if unknown. */
  async currentBranch(path: string): Promise<string | null> {
    try {
      return (
        (
          await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
            cwd: path,
          })
        ).trim() || null
      );
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------

  /** git on a mirror, addressed with `--git-dir` (no discovery). */
  private git(
    mirrorPath: string,
    args: string[],
    options: { timeoutMs?: number } = {},
  ): Promise<string> {
    return runGit([`--git-dir=${mirrorPath}`, ...args], options);
  }

  /** Settings every mirror gets. */
  private async configureMirror(path: string): Promise<void> {
    const config = (name: string, value: string) =>
      this.git(path, ['config', '--', name, value]);
    // Reflogs for all refs, as in non-bare repositories.
    await config('core.logAllRefUpdates', 'true');
    // Pushes from session clones (local projects) may only fast-forward
    // and never delete branches.
    await config('receive.denyNonFastForwards', 'true');
    await config('receive.denyDeletes', 'true');
  }

  private async initLocalMirror(path: string): Promise<void> {
    if (await exists(path)) {
      throw new Error(
        `${path} exists but is not a bare repository; move it away first`,
      );
    }
    await mkdir(dirname(path), { recursive: true });
    await runGit([
      'init',
      '--quiet',
      '--bare',
      '--initial-branch=main',
      '--',
      path,
    ]);
    await this.configureMirror(path);
  }

  /**
   * Clones into a temporary directory next to the target and renames it,
   * so an interrupted clone never looks like a finished one. Leftovers of
   * earlier interrupted clones of the same repository are removed.
   */
  private async cloneMirror(path: string, url: string): Promise<void> {
    if (await exists(path)) {
      throw new Error(
        `${path} exists but is not a bare repository; move it away first`,
      );
    }
    const parent = dirname(path);
    const prefix = `.${basename(path)}.clone-`;
    await mkdir(parent, { recursive: true });
    for (const entry of await readdir(parent)) {
      if (entry.startsWith(prefix)) {
        await rm(join(parent, entry), { recursive: true, force: true });
      }
    }
    const temporary = join(parent, prefix + randomBytes(4).toString('hex'));
    try {
      await runGit(['init', '--quiet', '--bare', '--', temporary]);
      await this.configureMirror(temporary);
      const config = (name: string, value: string) =>
        this.git(temporary, ['config', '--', name, value]);
      await config('remote.origin.url', url);
      await config('remote.origin.fetch', MIRROR_FETCH_REFSPEC);
      await this.git(temporary, ['fetch', ...FETCH_OPTIONS, 'origin'], {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  private async hasRemote(mirrorPath: string): Promise<boolean> {
    try {
      await this.git(mirrorPath, ['config', '--get', 'remote.origin.url']);
      return true;
    } catch {
      return false;
    }
  }

  /** Refuses to fetch into a mirror of another remote. */
  private async checkOrigin(mirrorPath: string, url: string): Promise<void> {
    let origin = '';
    try {
      origin = (
        await this.git(mirrorPath, ['config', '--get', 'remote.origin.url'])
      ).trim();
    } catch {
      // no origin configured
    }
    if (origin !== url) {
      throw new Error(
        `${mirrorPath} is a mirror of ${origin || 'nothing'}, not of ${url}`,
      );
    }
  }

  /**
   * Points the mirror's HEAD at the remote's default branch (it may have
   * changed), so session clones get `origin/HEAD`. Returns the branch, or
   * `null` if the remote has none (empty repository).
   */
  private async followRemoteHead(mirrorPath: string): Promise<string | null> {
    const branch = parseRemoteHead(
      await this.git(mirrorPath, ['ls-remote', '--symref', 'origin', 'HEAD'], {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      }),
    );
    if (branch && isValidBranchName(branch)) {
      await this.git(mirrorPath, [
        'symbolic-ref',
        'HEAD',
        `refs/heads/${branch}`,
      ]);
      return branch;
    }
    return null;
  }

  /** Branch HEAD of the mirror points to (may be unborn). */
  private async headBranch(mirrorPath: string): Promise<string | null> {
    try {
      return (
        (
          await this.git(mirrorPath, [
            'symbolic-ref',
            '--quiet',
            '--short',
            'HEAD',
          ])
        ).trim() || null
      );
    } catch {
      return null;
    }
  }
}
