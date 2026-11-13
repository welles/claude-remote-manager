import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { handOverToSession } from '../common/ownership';
import {
  PROCESS_LAUNCHER,
  SINGLE_USER,
  type ProcessLauncher,
} from '../common/process-isolation';
import {
  GIT_NETWORK_TIMEOUT_MS,
  retryOnLockContention,
  runGit,
  runGitToFile,
  type GitRunOptions,
} from './git-runner';
import {
  identityEnvironment,
  type GitAuth,
  type GitIdentity,
} from './git-auth';
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

export interface MirrorUpdateOptions {
  /**
   * Credentials for the network commands, obtained right before they run
   * (e.g. a fresh installation token); `null` uses git's own (SSH key,
   * credential helper of the API's environment).
   */
  auth?: () => Promise<GitAuth | null>;
  /**
   * Author of the initial empty commit on `main` of a new local project.
   * Required when the mirror of a local project is created.
   */
  identity?: GitIdentity | null;
}

/** Session clone settings, see {@link GitService.configureClone}. */
export interface CloneConfiguration {
  /** Commit identity; `null` leaves it unset, so git refuses to commit. */
  identity: GitIdentity | null;
  /**
   * Credential helper command for `origin` (`!<command>`); `null` keeps
   * git's defaults.
   */
  credentialHelper: string | null;
}

/** Commit message of the first commit of a local project. */
export const INITIAL_COMMIT_MESSAGE = 'Initial commit';

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
  /**
   * The newest update per mirror: running, or queued behind the mirror's
   * lock (`started` false) for callers to join.
   */
  private readonly updates = new Map<
    string,
    { promise: Promise<MirrorState>; started: boolean }
  >();

  constructor(
    @Optional()
    @Inject(PROCESS_LAUNCHER)
    readonly launcher: ProcessLauncher = SINGLE_USER,
  ) {}

  /** Whether a clone or fetch of this mirror is running or queued. */
  isUpdating(mirrorPath: string): boolean {
    return this.updates.has(mirrorPath);
  }

  /**
   * Creates the mirror if it does not exist yet (clone from `remoteUrl`, or
   * an empty repository on `main` for a local project), otherwise fetches
   * (nothing to do for a local project). The result is at least as new as
   * the call: it joins an update of the same mirror that has not started
   * yet; if one is already running (its fetch may predate the call), it
   * queues one follow-up update, which later callers join, so a burst of
   * calls costs at most one more fetch.
   */
  updateMirror(
    mirrorPath: string,
    remoteUrl: string | null,
    options: MirrorUpdateOptions = {},
  ): Promise<MirrorState> {
    const pending = this.updates.get(mirrorPath);
    if (pending && !pending.started) {
      return pending.promise;
    }
    const entry = { started: false } as {
      promise: Promise<MirrorState>;
      started: boolean;
    };
    entry.promise = this.locks
      .run(mirrorPath, () => {
        // From here on, a new caller may be too late for this fetch.
        entry.started = true;
        return this.fetchMirror(mirrorPath, remoteUrl, options);
      })
      .finally(() => {
        if (this.updates.get(mirrorPath) === entry) {
          this.updates.delete(mirrorPath);
        }
      });
    this.updates.set(mirrorPath, entry);
    return entry.promise;
  }

  /** The update itself; call with the mirror locked. */
  private async fetchMirror(
    mirrorPath: string,
    remoteUrl: string | null,
    options: MirrorUpdateOptions,
  ): Promise<MirrorState> {
    const created = !(await this.isBareRepository(mirrorPath));
    if (remoteUrl === null) {
      if (created) {
        await this.initLocalMirror(mirrorPath, options.identity ?? null);
      }
      return { defaultBranch: await this.headBranch(mirrorPath), created };
    }
    const env = (await options.auth?.())?.env;
    if (created) {
      await this.cloneMirror(mirrorPath, remoteUrl, env);
    } else {
      await this.checkOrigin(mirrorPath, remoteUrl);
      await retryOnLockContention(() =>
        this.git(mirrorPath, ['fetch', ...FETCH_OPTIONS, 'origin'], {
          timeoutMs: GIT_NETWORK_TIMEOUT_MS,
          env,
        }),
      );
    }
    return {
      defaultBranch: await this.followRemoteHead(mirrorPath, env),
      created,
    };
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
      // As the API: only the mirror's owner may hardlink its objects.
      await this.locks.run(mirrorPath, () =>
        this.api([
          'clone',
          '--local',
          '--no-checkout',
          '--quiet',
          '--',
          mirrorPath,
          path,
        ]),
      );
      // From here on the clone is the session's.
      await handOverToSession(path, this.launcher);
      const inClone = (args: string[]) => this.inClone(path, args);
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
      const commit = await this.localBranchCommit(clonePath, sourceBranch);
      if (!commit) {
        throw new Error(`The branch ${sourceBranch} has no commits`);
      }
      // Without "+": only a fast-forward is accepted.
      await this.importCommit(
        mirrorPath,
        clonePath,
        sourceBranch,
        commit,
        await this.branchCommit(mirrorPath, targetBranch),
        `refs/heads/${targetBranch}`,
      );
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
          await this.inClone(path, [
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

  /**
   * Settings of a session clone: the commit identity (with
   * `user.useConfigOnly`, so git never falls back to a guessed or the
   * machine's global identity) and the credential helper for `origin`.
   * The helper list is reset first, so no other helper of the user's or
   * system configuration is asked for (or stores) credentials.
   */
  async configureClone(
    path: string,
    configuration: CloneConfiguration,
  ): Promise<void> {
    await this.setIdentity(path, configuration.identity);
    if (configuration.credentialHelper !== null) {
      await this.setCredentialHelper(path, configuration.credentialHelper);
    }
  }

  /**
   * Makes `helper` the only credential helper of a clone (the list is reset
   * first, so no helper of the user's or system configuration is asked or
   * stores anything), with the repository path in the request.
   */
  async setCredentialHelper(path: string, helper: string): Promise<void> {
    const inClone = (args: string[]) => this.inClone(path, args);
    await inClone(['config', '--unset-all', 'credential.helper']).catch(
      () => undefined,
    );
    await inClone(['config', '--add', '--', 'credential.helper', '']);
    await inClone(['config', '--add', '--', 'credential.helper', helper]);
    await inClone(['config', '--', 'credential.useHttpPath', 'true']);
  }

  /**
   * Sets the commit identity of a clone. With `null`, name and email are
   * set empty, which hides any global identity: git then refuses to commit
   * ("empty ident name not allowed") instead of using someone else's.
   */
  async setIdentity(path: string, identity: GitIdentity | null): Promise<void> {
    const inClone = (args: string[]) => this.inClone(path, args);
    await inClone(['config', '--', 'user.useConfigOnly', 'true']);
    await inClone(['config', '--', 'user.name', identity?.name ?? '']);
    await inClone(['config', '--', 'user.email', identity?.email ?? '']);
  }

  /** Points `origin` of a session clone to another URL. */
  async setOrigin(path: string, url: string): Promise<void> {
    await this.inClone(path, ['config', '--', 'remote.origin.url', url]);
  }

  /** Commit of a local branch of a clone; `null` if unborn or missing. */
  async localBranchCommit(
    path: string,
    branch: string,
  ): Promise<string | null> {
    return this.verify(path, `refs/heads/${branch}`);
  }

  /** Commit of `origin/<branch>` as the clone last saw it. */
  async remoteBranchCommit(
    path: string,
    branch: string,
  ): Promise<string | null> {
    return this.verify(path, `refs/remotes/origin/${branch}`);
  }

  /**
   * Whether the commits between `base` (or the root) and `head` change
   * files under `.github/workflows` (pushing them needs the `workflows`
   * permission on GitHub).
   */
  async changesWorkflows(
    path: string,
    head: string,
    base: string | null,
    { mirror = false }: { mirror?: boolean } = {},
  ): Promise<boolean> {
    const range = base ? [`${base}..${head}`] : [head];
    const args = [
      'log',
      '--format=',
      '--name-only',
      ...range,
      '--',
      '.github/workflows',
    ];
    const output = mirror
      ? await this.git(path, args)
      : await this.inClone(path, args);
    return output.trim().length > 0;
  }

  /**
   * Pushes the session branch of a clone to the remote (no force) and sets
   * it as the clone's upstream, so a later `git push` there needs no
   * arguments. The session's commits are brought into the mirror first, as
   * a bundle the session user writes from the clone; the push itself runs
   * in the mirror as the API, so the credentials never reach a process of
   * the session. `auth` gets whether the commits change workflow files.
   * Returns the pushed commit.
   */
  async pushSessionBranch(options: {
    mirrorPath: string;
    clonePath: string;
    branch: string;
    baseCommit: string | null;
    auth: (changesWorkflows: boolean) => Promise<GitAuth | null>;
  }): Promise<string> {
    const { mirrorPath, clonePath, branch, baseCommit } = options;
    if (!isValidBranchName(branch)) {
      throw new Error(`"${branch}" is not a valid branch name`);
    }
    const commit = await this.localBranchCommit(clonePath, branch);
    if (!commit) {
      throw new Error(`The branch ${branch} has no commits yet`);
    }
    const temporary = `refs/crm/push/${branch}`;
    await this.locks.run(mirrorPath, async () => {
      await this.importCommit(
        mirrorPath,
        clonePath,
        branch,
        commit,
        baseCommit,
        `+${temporary}`,
      );
      try {
        const workflows = await this.changesWorkflows(
          mirrorPath,
          commit,
          baseCommit && (await this.hasCommit(mirrorPath, baseCommit))
            ? baseCommit
            : null,
          { mirror: true },
        );
        const auth = await options.auth(workflows);
        await this.git(
          mirrorPath,
          ['push', '--quiet', 'origin', `${commit}:refs/heads/${branch}`],
          { timeoutMs: GIT_NETWORK_TIMEOUT_MS, env: auth?.env },
        );
      } finally {
        await this.git(mirrorPath, ['update-ref', '-d', temporary]).catch(
          () => undefined,
        );
      }
    });
    const inClone = (args: string[]) => this.inClone(clonePath, args);
    await inClone(['update-ref', `refs/remotes/origin/${branch}`, commit]);
    await inClone(['config', '--', `branch.${branch}.remote`, 'origin']);
    await inClone([
      'config',
      '--',
      `branch.${branch}.merge`,
      `refs/heads/${branch}`,
    ]);
    return commit;
  }

  /**
   * Turns a local project into a repository with remote: sets `origin` of
   * the mirror to `url` and pushes all its branches and tags there (no
   * force). Afterwards the mirror is fetched like any other.
   */
  async attachRemote(
    mirrorPath: string,
    url: string,
    auth: GitAuth | null,
  ): Promise<void> {
    await this.locks.run(mirrorPath, async () => {
      if (await this.hasRemote(mirrorPath)) {
        throw new Error('The project has a remote already');
      }
      await this.git(mirrorPath, ['config', '--', 'remote.origin.url', url]);
      await this.git(mirrorPath, [
        'config',
        '--',
        'remote.origin.fetch',
        MIRROR_FETCH_REFSPEC,
      ]);
      try {
        await this.git(
          mirrorPath,
          [
            'push',
            '--quiet',
            'origin',
            'refs/heads/*:refs/heads/*',
            'refs/tags/*:refs/tags/*',
          ],
          { timeoutMs: GIT_NETWORK_TIMEOUT_MS, env: auth?.env },
        );
      } catch (error) {
        // Back to a local project, so the attempt can be repeated.
        await this.git(mirrorPath, [
          'config',
          '--remove-section',
          'remote.origin',
        ]).catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * What deleting a session clone would lose: uncommitted files (modified,
   * staged, untracked and not ignored), commits on local branches that no
   * remote-tracking branch of the clone has (and that are not reachable
   * from `knownRemoteCommits`, e.g. a pull request's head on GitHub), and
   * stash entries. Lists hold at most `limit` entries; counts are complete.
   * git runs as the session user, without taking locks.
   */
  async cloneLoss(
    path: string,
    {
      knownRemoteCommits = [],
      limit = 50,
    }: {
      knownRemoteCommits?: string[];
      limit?: number;
    } = {},
  ): Promise<{
    uncommittedFiles: string[];
    uncommittedCount: number;
    unpushedCommits: { branch: string; sha: string; subject: string }[];
    unpushedCount: number;
    stashes: number;
  }> {
    const inClone = (args: string[]) =>
      this.inClone(path, ['--no-optional-locks', ...args]);
    const status = await inClone([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ]);
    const files: string[] = [];
    const entries = status.split('\0');
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry.length < 4) {
        continue;
      }
      files.push(entry.slice(3));
      if (/^[RC]/.test(entry)) {
        index++; // the original path of a rename or copy
      }
    }
    const known: string[] = [];
    for (const commit of knownRemoteCommits) {
      if (/^[0-9a-f]{40}$/.test(commit) && (await this.verify(path, commit))) {
        known.push(commit);
      }
    }
    const range = ['--branches', '--not', '--remotes', ...known];
    const count = Number(
      (await inClone(['rev-list', '--count', ...range])).trim() || '0',
    );
    const log =
      count > 0
        ? await inClone([
            'log',
            `--max-count=${limit}`,
            '--source',
            '--format=%H%x09%S%x09%s',
            ...range,
          ])
        : '';
    const unpushedCommits = log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, source, ...subject] = line.split('\t');
        return {
          sha,
          branch: source.replace(/^refs\/heads\//, ''),
          subject: subject.join('\t'),
        };
      });
    const stash = await inClone(['stash', 'list', '--format=%H']).catch(
      () => '',
    );
    return {
      uncommittedFiles: files.slice(0, limit),
      uncommittedCount: files.length,
      unpushedCommits,
      unpushedCount: count,
      stashes: stash.split('\n').filter(Boolean).length,
    };
  }

  /** Whether the mirror has a remote (`false` for a local project). */
  async hasRemote(mirrorPath: string): Promise<boolean> {
    try {
      await this.git(mirrorPath, ['config', '--get', 'remote.origin.url']);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------

  private async verify(path: string, ref: string): Promise<string | null> {
    try {
      return (
        (
          await this.inClone(path, [
            'rev-parse',
            '--verify',
            '--quiet',
            `${ref}^{commit}`,
          ])
        ).trim() || null
      );
    } catch {
      return null;
    }
  }

  /** git on a mirror, addressed with `--git-dir` (no discovery). */
  private git(
    mirrorPath: string,
    args: string[],
    options: { timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<string> {
    return this.api([`--git-dir=${mirrorPath}`, ...args], options);
  }

  /** git as the API (mirrors), without the API's capabilities. */
  private api(
    args: string[],
    options: Omit<GitRunOptions, 'launcher' | 'as'> = {},
  ): Promise<string> {
    return runGit(args, { ...options, launcher: this.launcher, as: 'api' });
  }

  /** git in a session clone, as the session user. */
  private inClone(
    path: string,
    args: string[],
    options: Omit<GitRunOptions, 'launcher' | 'as' | 'cwd'> = {},
  ): Promise<string> {
    return runGit(args, {
      ...options,
      cwd: path,
      launcher: this.launcher,
      as: 'session',
    });
  }

  private async hasCommit(
    mirrorPath: string,
    commit: string,
  ): Promise<boolean> {
    try {
      await this.git(mirrorPath, ['cat-file', '-e', `${commit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Brings `commit` (the tip of `branch` in a session clone) into the mirror
   * as `targetRef` (with leading "+" to force). The session user writes a
   * bundle of the branch (only what the mirror lacks, if `known` is a
   * commit it has); the API fetches the bundle. git never runs as the API
   * in the session's repository. Call with the mirror locked.
   */
  private async importCommit(
    mirrorPath: string,
    clonePath: string,
    branch: string,
    commit: string,
    known: string | null,
    targetRef: string,
  ): Promise<void> {
    const ref = targetRef.replace(/^\+/, '');
    if (await this.hasCommit(mirrorPath, commit)) {
      const current = await this.git(mirrorPath, [
        'rev-parse',
        '--verify',
        '--quiet',
        ref,
      ]).catch(() => '');
      if (!targetRef.startsWith('+') && current.trim()) {
        // Same rule as a fetch without "+": fast-forward only.
        await this.git(mirrorPath, [
          'merge-base',
          '--is-ancestor',
          current.trim(),
          commit,
        ]).catch(() => {
          throw new Error(
            `${ref} cannot be fast-forwarded to ${commit.slice(0, 12)}`,
          );
        });
      }
      await this.git(mirrorPath, ['update-ref', ref, commit]);
      return;
    }
    const bundle = join(
      dirname(mirrorPath),
      `.${basename(mirrorPath)}.import-${randomBytes(4).toString('hex')}.bundle`,
    );
    const create = (exclude: string[]) =>
      runGitToFile(
        [
          'bundle',
          'create',
          '--quiet',
          '-',
          `refs/heads/${branch}`,
          ...exclude,
        ],
        bundle,
        { cwd: clonePath, launcher: this.launcher, as: 'session' },
      );
    try {
      const prerequisite =
        known && (await this.hasCommit(mirrorPath, known)) ? [`^${known}`] : [];
      try {
        await create(prerequisite);
      } catch (error) {
        if (prerequisite.length === 0) {
          throw error;
        }
        await rm(bundle, { force: true });
        await create([]);
      }
      await this.git(mirrorPath, [
        'fetch',
        '--no-tags',
        '--quiet',
        '--',
        bundle,
        `${targetRef.startsWith('+') ? '+' : ''}refs/heads/${branch}:${ref}`,
      ]);
      const imported = (await this.git(mirrorPath, ['rev-parse', ref])).trim();
      if (imported !== commit) {
        throw new Error(
          `The session branch moved while it was pushed; try again`,
        );
      }
    } finally {
      await rm(bundle, { force: true });
    }
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

  /**
   * A new local project: an empty bare repository whose `main` starts with
   * an empty commit, so every session has a real base commit and parallel
   * first sessions share history.
   */
  private async initLocalMirror(
    path: string,
    identity: GitIdentity | null,
  ): Promise<void> {
    if (await exists(path)) {
      throw new Error(
        `${path} exists but is not a bare repository; move it away first`,
      );
    }
    if (!identity) {
      throw new Error(
        'The git author name and email are not set; set them in the settings first',
      );
    }
    await mkdir(dirname(path), { recursive: true });
    try {
      await this.api([
        'init',
        '--quiet',
        '--bare',
        '--initial-branch=main',
        '--',
        path,
      ]);
      await this.configureMirror(path);
      const tree = (
        await this.git(path, ['hash-object', '-t', 'tree', '-w', '/dev/null'])
      ).trim();
      const commit = (
        await this.git(
          path,
          ['commit-tree', tree, '-m', INITIAL_COMMIT_MESSAGE],
          { env: identityEnvironment(identity) },
        )
      ).trim();
      await this.git(path, ['update-ref', 'refs/heads/main', commit, '']);
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Clones into a temporary directory next to the target and renames it,
   * so an interrupted clone never looks like a finished one. Leftovers of
   * earlier interrupted clones of the same repository are removed.
   */
  private async cloneMirror(
    path: string,
    url: string,
    env?: Record<string, string>,
  ): Promise<void> {
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
      await this.api(['init', '--quiet', '--bare', '--', temporary]);
      await this.configureMirror(temporary);
      const config = (name: string, value: string) =>
        this.git(temporary, ['config', '--', name, value]);
      await config('remote.origin.url', url);
      await config('remote.origin.fetch', MIRROR_FETCH_REFSPEC);
      await this.git(temporary, ['fetch', ...FETCH_OPTIONS, 'origin'], {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
        env,
      });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
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
  private async followRemoteHead(
    mirrorPath: string,
    env?: Record<string, string>,
  ): Promise<string | null> {
    const branch = parseRemoteHead(
      await this.git(mirrorPath, ['ls-remote', '--symref', 'origin', 'HEAD'], {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
        env,
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
