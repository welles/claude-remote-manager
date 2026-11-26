import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cloneOf } from '../sessions/session-clones';
import { join } from 'node:path';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  MAX_LISTED_COMMITS,
  type CommitDiffResponse,
  type CommitSummary,
  type DiffComparison,
  type RepositoryDiff,
  type SessionDiffFile,
  type SessionDiffLimits,
  type SessionDiffResponse,
} from '@claude-remote-manager/shared-types';
import { isRetiredClone } from '@claude-remote-manager/shared-types';
import {
  PROCESS_LAUNCHER,
  SINGLE_USER,
  type ProcessLauncher,
} from '../common/process-isolation';
import { gitEnvironment, runGit } from '../git/git-runner';
import {
  SessionRepository,
  type SessionDirectoryRecord,
} from '../sessions/session.repository';
import {
  DiffOutputParser,
  PatchParser,
  type FilePatch,
  type RawChange,
} from './git-diff-parser';
import {
  COMMIT_ID,
  listCommits,
  readCommit,
  type CloneGit,
} from './commit-log';

export const SESSION_DIFF_LIMITS: SessionDiffLimits = {
  maxFiles: 1000,
  maxFileLines: 3000,
  maxTotalLines: 20_000,
  maxSingleFileLines: 20_000,
};

/** git's output of one diff is not read beyond this. */
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const DIFF_TIMEOUT_MS = 120_000;
/** Temporary indexes older than this are left over from a stopped server. */
export const STALE_INDEX_MINUTES = 10;

/**
 * Options of every diff: no external diff tools or text conversions (they
 * would run commands from the repository's configuration), renames
 * detected, no colors.
 */
const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color', '-M'];

/** Environment of the diff of a commit: paths literal, no index locks. */
const COMMIT_DIFF_ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_LITERAL_PATHSPECS: '1',
};

class Budget {
  used = 0;
  constructor(
    readonly perFile: number,
    readonly total: number,
  ) {}
}

/**
 * The diff of a session: per session clone, everything that differs from
 * the commit the clone started at (`base_commit`), committed or not,
 * including untracked files that are not ignored, with renames.
 *
 * git runs in the clone as the session user (in `separate-users` mode):
 * the clone's content and configuration are the session's, so git never
 * runs there as the API. Untracked files are included without touching the
 * clone's index or objects: a temporary index in the clone's git directory
 * (from the real one, so git can skip unchanged files) gets the untracked
 * files as intent-to-add entries, and `git diff <base>` compares the
 * working tree against the base commit through it.
 */
@Injectable()
export class SessionDiffService {
  constructor(
    private readonly sessions: SessionRepository,
    @Optional()
    @Inject(PROCESS_LAUNCHER)
    private readonly launcher: ProcessLauncher = SINGLE_USER,
  ) {}

  /** Limits of the diffs (replaceable in tests). */
  limits: SessionDiffLimits = SESSION_DIFF_LIMITS;

  async sessionDiff(sessionId: string): Promise<SessionDiffResponse> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    const budget = new Budget(
      this.limits.maxFileLines,
      this.limits.maxTotalLines,
    );
    const repositories: RepositoryDiff[] = [];
    for (const directory of record.directories) {
      if (
        directory.kind === 'clone' &&
        directory.repositoryId &&
        // A further branch's clone removed after its pull request is done.
        !isRetiredClone(directory)
      ) {
        repositories.push(await this.repositoryDiff(directory, budget));
      }
    }
    return { sessionId, repositories, limits: this.limits };
  }

  /** One file of a session clone's diff, with the larger single-file limit. */
  async fileDiff(
    sessionId: string,
    repositoryId: string,
    path: string,
    oldPath: string | null,
    branch: string | null = null,
  ): Promise<SessionDiffFile> {
    const record = this.sessions.get(sessionId);
    const directory = record
      ? cloneOf(record.directories, repositoryId, branch)
      : undefined;
    if (!record || !directory) {
      throw new NotFoundException(
        `Repository ${repositoryId} is not part of session ${sessionId}`,
      );
    }
    checkPaths(path, oldPath);
    const { files, message } = await this.diffClone(
      directory,
      new Budget(
        this.limits.maxSingleFileLines,
        this.limits.maxSingleFileLines,
      ),
      oldPath ? [oldPath, path] : [path],
      true,
    );
    const file = files.find(
      (entry) =>
        entry.path === path && (oldPath === null || entry.oldPath === oldPath),
    );
    if (!file) {
      throw new NotFoundException(message ?? `${path} has no changes`);
    }
    return file;
  }

  private async repositoryDiff(
    directory: SessionDirectoryRecord,
    budget: Budget,
  ): Promise<RepositoryDiff> {
    const base: RepositoryDiff = {
      repositoryId: directory.repositoryId as string,
      repository: directory.repositoryName ?? directory.path,
      path: directory.path,
      branch: directory.branch,
      baseBranch: directory.baseBranch,
      startCommit: directory.baseCommit,
      comparison: null,
      headCommit: null,
      state: 'unavailable',
      message: null,
      files: [],
      fileCount: 0,
      additions: 0,
      deletions: 0,
    };
    if (directory.state !== 'ready') {
      return {
        ...base,
        message: `The clone is not available (${directory.state}).`,
      };
    }
    if (!directory.baseCommit) {
      return {
        ...base,
        message: 'The clone has no base commit to compare to.',
      };
    }
    try {
      const result = await this.diffClone(directory, budget, null, false);
      const commits = await this.commitsSince(
        directory,
        result.headCommit,
        result.comparison,
      );
      return { ...base, ...result, ...commits, state: 'ok', message: null };
    } catch (error) {
      return {
        ...base,
        message: `git could not compute the diff: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * One commit of a session clone with its diff against its first parent
   * (a root commit: against the empty tree); with `path`, only that file,
   * with the larger single-file limit. Any commit the clone has can be
   * shown, also one a rebase replaced.
   */
  async commitDiff(
    sessionId: string,
    repositoryId: string,
    branch: string | null,
    sha: string,
  ): Promise<CommitDiffResponse> {
    const directory = this.readyClone(sessionId, repositoryId, branch);
    const git = this.cloneGit(directory);
    const commit = await this.requireCommit(git, sha);
    const parent = commit.parents[0] ?? null;
    const budget = new Budget(
      this.limits.maxFileLines,
      this.limits.maxTotalLines,
    );
    const { changes, patches } = await this.runDiff(
      directory.path,
      COMMIT_DIFF_ENV,
      [
        'diff',
        ...DIFF_OPTIONS,
        '--raw',
        '--numstat',
        '-p',
        '-z',
        parent ?? (await emptyTree(git)),
        commit.sha,
      ],
      budget,
      'drop',
    );
    const listed = changes.slice(0, this.limits.maxFiles);
    return {
      repositoryId,
      repository: directory.repositoryName ?? directory.path,
      branch: directory.branch,
      commit: {
        ...commit,
        fileCount: changes.length,
        additions: changes.reduce((sum, change) => sum + change.additions, 0),
        deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
      },
      parent,
      files: listed.map((change, position) =>
        diffFile(change, patches[position], budget.perFile),
      ),
      fileCount: changes.length,
      limits: this.limits,
    };
  }

  /** One file of a commit's diff, with the larger single-file limit. */
  async commitFileDiff(
    sessionId: string,
    repositoryId: string,
    branch: string | null,
    sha: string,
    path: string,
    oldPath: string | null,
  ): Promise<SessionDiffFile> {
    checkPaths(path, oldPath);
    const directory = this.readyClone(sessionId, repositoryId, branch);
    const git = this.cloneGit(directory);
    const commit = await this.requireCommit(git, sha);
    const budget = new Budget(
      this.limits.maxSingleFileLines,
      this.limits.maxSingleFileLines,
    );
    const { changes, patches } = await this.runDiff(
      directory.path,
      COMMIT_DIFF_ENV,
      [
        'diff',
        ...DIFF_OPTIONS,
        '--raw',
        '--numstat',
        '-p',
        '-z',
        commit.parents[0] ?? (await emptyTree(git)),
        commit.sha,
        '--',
        ...(oldPath ? [oldPath, path] : [path]),
      ],
      budget,
      'truncate',
    );
    const position = changes.findIndex(
      (entry) =>
        entry.path === path && (oldPath === null || entry.oldPath === oldPath),
    );
    if (position < 0) {
      throw new NotFoundException(`${path} has no changes in this commit`);
    }
    return diffFile(changes[position], patches[position], budget.perFile);
  }

  /**
   * The commits of a clone since what its diff compares against, newest
   * first (none without a comparison, or when git fails).
   */
  private async commitsSince(
    directory: SessionDirectoryRecord,
    headCommit: string | null,
    comparison: DiffComparison | null,
  ): Promise<{ commits: CommitSummary[]; commitCount: number }> {
    if (!headCommit || !comparison || !COMMIT_ID.test(headCommit)) {
      return { commits: [], commitCount: 0 };
    }
    try {
      const { commits, count } = await listCommits(
        this.cloneGit(directory),
        headCommit,
        [comparison.commit],
        MAX_LISTED_COMMITS,
      );
      return { commits, commitCount: count };
    } catch {
      return { commits: [], commitCount: 0 };
    }
  }

  /** A ready clone of the session, or a 404. */
  private readyClone(
    sessionId: string,
    repositoryId: string,
    branch: string | null,
  ): SessionDirectoryRecord {
    const record = this.sessions.get(sessionId);
    const directory = record
      ? cloneOf(record.directories, repositoryId, branch)
      : undefined;
    if (!record || !directory) {
      throw new NotFoundException(
        `Repository ${repositoryId} is not part of session ${sessionId}`,
      );
    }
    if (directory.state !== 'ready') {
      throw new NotFoundException(
        `The clone is not available (${directory.state}).`,
      );
    }
    return directory;
  }

  /** git in a session clone, as the session user. */
  private cloneGit(directory: SessionDirectoryRecord): CloneGit {
    return (args) =>
      runGit(args, {
        cwd: directory.path,
        launcher: this.launcher,
        as: 'session',
        timeoutMs: DIFF_TIMEOUT_MS,
      });
  }

  private async requireCommit(
    git: CloneGit,
    sha: string,
  ): Promise<CommitSummary> {
    if (!COMMIT_ID.test(sha)) {
      throw new BadRequestException('sha must be a full commit ID');
    }
    const commit = await readCommit(git, sha).catch(() => null);
    if (!commit) {
      throw new NotFoundException(`The clone has no commit ${sha}`);
    }
    return commit;
  }

  /** The diff of a clone (optionally of some paths only). */
  private async diffClone(
    directory: SessionDirectoryRecord,
    budget: Budget,
    paths: string[] | null,
    single: boolean,
  ): Promise<{
    files: SessionDiffFile[];
    fileCount: number;
    additions: number;
    deletions: number;
    headCommit: string | null;
    comparison: DiffComparison | null;
    message: string | null;
  }> {
    const cwd = directory.path;
    const startCommit = directory.baseCommit;
    if (!startCommit || directory.state !== 'ready') {
      return {
        files: [],
        fileCount: 0,
        additions: 0,
        deletions: 0,
        headCommit: null,
        comparison: null,
        message: 'The clone is not available.',
      };
    }
    const git = (args: string[], env: Record<string, string> = {}) =>
      runGit(args, {
        cwd,
        env,
        launcher: this.launcher,
        as: 'session',
        timeoutMs: DIFF_TIMEOUT_MS,
      });
    const headCommit =
      (
        await git(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')
      ).trim() || null;
    const comparison = await this.comparison(
      git,
      directory.baseBranch,
      headCommit,
      startCommit,
    );
    const gitDir = (await git(['rev-parse', '--absolute-git-dir'])).trim();
    const index = join(
      gitDir,
      `crm-diff-${randomBytes(8).toString('hex')}.index`,
    );
    // Temporary indexes of diffs cut off by a server stop.
    await this.asSession('find', [
      gitDir,
      '-maxdepth',
      '1',
      '-name',
      'crm-diff-*.index*',
      '-mmin',
      `+${STALE_INDEX_MINUTES}`,
      '-delete',
    ]);
    const env = {
      GIT_INDEX_FILE: index,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_LITERAL_PATHSPECS: '1',
    };
    const pathspec = paths ? ['--', ...paths] : [];
    try {
      // A copy of the clone's index keeps the stat data of unchanged files
      // (fast on large trees) and leaves the index itself alone.
      if (!(await this.asSession('cp', ['--', join(gitDir, 'index'), index]))) {
        await git(['read-tree', headCommit ? 'HEAD' : '--empty'], env);
      }
      // Untracked, not ignored files as intent-to-add: no content is
      // written to the clone's objects.
      await git(['add', '--all', '--intent-to-add'], env);
      // File list and patches from one run: the n-th patch belongs to the
      // n-th listed file even if the session changes files meanwhile.
      const { changes, patches } = await this.runDiff(
        cwd,
        env,
        [
          'diff',
          ...DIFF_OPTIONS,
          '--raw',
          '--numstat',
          '-p',
          '-z',
          comparison.commit,
          ...pathspec,
        ],
        budget,
        single ? 'truncate' : 'drop',
      );
      const listed = changes.slice(0, this.limits.maxFiles);
      const totals = changes.reduce(
        (sum, change) => ({
          additions: sum.additions + change.additions,
          deletions: sum.deletions + change.deletions,
        }),
        { additions: 0, deletions: 0 },
      );
      return {
        files: listed.map((change, position) =>
          diffFile(change, patches[position], budget.perFile),
        ),
        fileCount: changes.length,
        ...totals,
        headCommit,
        comparison,
        message: null,
      };
    } finally {
      await this.remove(index);
    }
  }

  /**
   * What to compare the clone against: the merge base of `HEAD` and the
   * base branch as the clone knows it, `origin/<base branch>` (what the
   * session merges or rebases from; it is the remote-tracking ref of the
   * remote branch, set when the clone was made from the freshly fetched
   * mirror and moved by the session's own `git fetch`, so it is exactly
   * what the session could have brought in). Falls back to the commit
   * the session branch started at, saying why.
   */
  private async comparison(
    git: (args: string[]) => Promise<string>,
    baseBranch: string | null,
    headCommit: string | null,
    startCommit: string,
  ): Promise<DiffComparison> {
    const fallback = (reason: string): DiffComparison => ({
      commit: startCommit,
      basis: 'start_commit',
      ref: null,
      fallbackReason: reason,
    });
    if (!baseBranch) {
      return fallback('The clone has no base branch.');
    }
    if (!headCommit) {
      return fallback('The session branch has no commit.');
    }
    const ref = `origin/${baseBranch}`;
    const known = (
      await git([
        'rev-parse',
        '--verify',
        '--quiet',
        // Starts with "refs/", so never read as an option.
        `refs/remotes/${ref}^{commit}`,
      ]).catch(() => '')
    ).trim();
    if (!known) {
      return fallback(`The clone does not know ${ref}.`);
    }
    const mergeBase = (
      await git(['merge-base', 'HEAD', known]).catch(() => '')
    ).trim();
    if (!mergeBase) {
      return fallback(`The session branch and ${ref} have no common history.`);
    }
    return {
      commit: mergeBase,
      basis: 'merge_base',
      ref,
      fallbackReason: null,
    };
  }

  /**
   * Runs `git diff --raw --numstat -p -z` and parses its output as it
   * streams: the file list, then the patches, keeping lines within the
   * budget. Stops reading after the patches of the listed files, or after
   * too much output.
   */
  private runDiff(
    cwd: string,
    env: Record<string, string>,
    args: string[],
    budget: Budget,
    mode: 'drop' | 'truncate',
  ): Promise<{ changes: RawChange[]; patches: FilePatch[] }> {
    const patches = new PatchParser(
      (fileIndex, fileLines) => {
        if (
          fileIndex >= this.limits.maxFiles ||
          fileLines >= budget.perFile ||
          budget.used >= budget.total
        ) {
          return false;
        }
        budget.used++;
        return true;
      },
      // Lines of a file that is left out do not count.
      (kept) => (budget.used -= kept),
      mode,
    );
    const output = new DiffOutputParser(patches);
    const command = this.launcher.command('session', 'git', [
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ]);
    return new Promise((resolve, reject) => {
      const child = spawn(command.command, command.args, {
        cwd,
        env: {
          ...gitEnvironment(process.env, this.launcher, 'session'),
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let bytes = 0;
      let stopped = false;
      let stderr = '';
      const stop = () => {
        if (!stopped) {
          stopped = true;
          child.kill('SIGKILL');
        }
      };
      const timer = setTimeout(stop, DIFF_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        if (stopped) {
          return;
        }
        bytes += chunk.length;
        output.push(chunk);
        const listed = Math.min(
          output.changes?.length ?? Infinity,
          this.limits.maxFiles,
        );
        if (patches.patches.length > listed) {
          // Patches beyond the listed files are not needed.
          patches.patches.splice(listed);
          stop();
        } else if (bytes > MAX_PATCH_BYTES) {
          // The last patch read may be incomplete.
          patches.patches.pop();
          stop();
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (!stopped) {
          if (code !== 0) {
            reject(
              new Error(
                stderr.trim().split('\n').at(-1) ||
                  `git diff exited with ${code}`,
              ),
            );
            return;
          }
          output.end();
        }
        if (output.changes === null) {
          reject(new Error('Too many changes to list'));
          return;
        }
        resolve({ changes: output.changes, patches: patches.patches });
      });
    });
  }

  /** Removes the temporary index (as the session user, in its clone). */
  private async remove(index: string): Promise<void> {
    await this.asSession('rm', ['-f', '--', index, `${index}.lock`]);
  }

  /** Runs a command as the session user; whether it succeeded. */
  private asSession(command: string, args: string[]): Promise<boolean> {
    const line = this.launcher.command('session', command, args);
    return new Promise((resolve) => {
      const child = spawn(line.command, line.args, {
        cwd: '/',
        env: this.launcher.environment('session'),
        stdio: 'ignore',
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }
}

/** Paths of a single-file diff: not empty, no NUL, not too long. */
function checkPaths(path: string, oldPath: string | null): void {
  for (const value of [path, oldPath]) {
    if (
      value !== null &&
      (!value || value.includes('\0') || value.length > 4096)
    ) {
      throw new BadRequestException('Invalid path');
    }
  }
}

/** The empty tree of the clone's hash algorithm (for root commits). */
async function emptyTree(git: CloneGit): Promise<string> {
  return (await git(['hash-object', '-t', 'tree', '/dev/null'])).trim();
}

/**
 * A file of a session diff from its listed change and its patch. A patch
 * whose line counts differ from the change's numbers is not used (the file
 * loads on its own instead), so a wrong pairing can never show one file's
 * changes under another's name.
 */
export function diffFile(
  change: RawChange,
  patch: FilePatch | undefined,
  perFileLines: number,
): SessionDiffFile {
  const file: SessionDiffFile = {
    path: change.path,
    oldPath: change.oldPath,
    status: change.status,
    binary: change.binary || patch?.binary === true,
    additions: change.additions,
    deletions: change.deletions,
    hunks: [],
    truncated: false,
    approximate: false,
    content: 'included',
  };
  if (file.binary) {
    return file;
  }
  if (
    !patch ||
    patch.additions !== change.additions ||
    patch.deletions !== change.deletions
  ) {
    // Not read (output limit reached before it), or not the patch the
    // numbers describe (never expected from one run): load it alone.
    return { ...file, content: 'omitted' };
  }
  if (!patch.dropped) {
    return { ...file, hunks: patch.hunks, truncated: patch.truncated };
  }
  return {
    ...file,
    content: patch.lines > perFileLines ? 'too_large' : 'omitted',
  };
}
