import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type {
  RepositoryDiff,
  SessionDiffFile,
  SessionDiffLimits,
  SessionDiffResponse,
} from '@claude-remote-manager/shared-types';
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
  parseRawNumstat,
  PatchParser,
  type FilePatch,
  type RawChange,
} from './git-diff-parser';

export const SESSION_DIFF_LIMITS: SessionDiffLimits = {
  maxFiles: 1000,
  maxFileLines: 3000,
  maxTotalLines: 20_000,
  maxSingleFileLines: 20_000,
};

/** git's output of one diff is not read beyond this. */
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const DIFF_TIMEOUT_MS = 120_000;

/**
 * Options of every diff: no external diff tools or text conversions (they
 * would run commands from the repository's configuration), renames
 * detected, no colors.
 */
const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color', '-M'];

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
      if (directory.kind === 'clone' && directory.repositoryId) {
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
  ): Promise<SessionDiffFile> {
    const record = this.sessions.get(sessionId);
    const directory = record?.directories.find(
      (entry) => entry.kind === 'clone' && entry.repositoryId === repositoryId,
    );
    if (!record || !directory) {
      throw new NotFoundException(
        `Repository ${repositoryId} is not part of session ${sessionId}`,
      );
    }
    for (const value of [path, oldPath]) {
      if (
        value !== null &&
        (!value || value.includes('\0') || value.length > 4096)
      ) {
        throw new BadRequestException('Invalid path');
      }
    }
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
      baseCommit: directory.baseCommit,
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
      return { ...base, ...result, state: 'ok', message: null };
    } catch (error) {
      return {
        ...base,
        message: `git could not compute the diff: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
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
    message: string | null;
  }> {
    const cwd = directory.path;
    const baseCommit = directory.baseCommit;
    if (!baseCommit || directory.state !== 'ready') {
      return {
        files: [],
        fileCount: 0,
        additions: 0,
        deletions: 0,
        headCommit: null,
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
    const gitDir = (await git(['rev-parse', '--absolute-git-dir'])).trim();
    const index = join(
      gitDir,
      `crm-diff-${randomBytes(8).toString('hex')}.index`,
    );
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
      const changes = parseRawNumstat(
        await git(
          [
            'diff',
            ...DIFF_OPTIONS,
            '--raw',
            '--numstat',
            '-z',
            baseCommit,
            ...pathspec,
          ],
          env,
        ),
      );
      const listed = changes.slice(0, this.limits.maxFiles);
      const patches = await this.patches(
        cwd,
        env,
        ['diff', ...DIFF_OPTIONS, '-p', baseCommit, ...pathspec],
        listed.length,
        budget,
        single ? 'truncate' : 'drop',
      );
      const totals = changes.reduce(
        (sum, change) => ({
          additions: sum.additions + change.additions,
          deletions: sum.deletions + change.deletions,
        }),
        { additions: 0, deletions: 0 },
      );
      return {
        files: listed.map((change, position) =>
          this.toFile(change, patches[position], budget),
        ),
        fileCount: changes.length,
        ...totals,
        headCommit,
        message: null,
      };
    } finally {
      await this.remove(index);
    }
  }

  private toFile(
    change: RawChange,
    patch: FilePatch | undefined,
    budget: Budget,
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
    if (!patch) {
      // Not read (output limit reached before it): load it alone.
      return { ...file, content: 'omitted' };
    }
    if (!patch.dropped) {
      return { ...file, hunks: patch.hunks, truncated: patch.truncated };
    }
    return {
      ...file,
      content: patch.lines > budget.perFile ? 'too_large' : 'omitted',
    };
  }

  /**
   * Runs `git diff -p` and parses its output line by line, keeping lines
   * within the budget; stops reading after `files` files or too much
   * output.
   */
  private patches(
    cwd: string,
    env: Record<string, string>,
    args: string[],
    files: number,
    budget: Budget,
    mode: 'drop' | 'truncate',
  ): Promise<FilePatch[]> {
    const parser = new PatchParser(
      (fileIndex, fileLines) => {
        if (fileLines >= budget.perFile || budget.used >= budget.total) {
          return false;
        }
        budget.used++;
        return true;
      },
      // Lines of a file that is left out do not count.
      (kept) => (budget.used -= kept),
      mode,
    );
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
        bytes += chunk.length;
        if (bytes > MAX_PATCH_BYTES) {
          stop();
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000);
      });
      const lines = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });
      lines.on('line', (line) => {
        if (stopped) {
          return;
        }
        parser.push(line);
        if (parser.patches.length > files) {
          // Files beyond the listed ones are not needed.
          parser.patches.pop();
          stop();
        }
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stopped) {
          reject(
            new Error(
              stderr.trim().split('\n').at(-1) ||
                `git diff exited with ${code}`,
            ),
          );
          return;
        }
        if (stopped) {
          // The last file read may be incomplete.
          const last = parser.patches.at(-1);
          if (last && bytes > MAX_PATCH_BYTES) {
            parser.patches.pop();
          }
        }
        resolve(parser.patches);
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
