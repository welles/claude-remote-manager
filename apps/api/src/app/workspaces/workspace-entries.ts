import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import {
  PROCESS_LAUNCHER,
  SINGLE_USER,
  type ProcessLauncher,
  type ProcessRole,
} from '../common/process-isolation';

/**
 * Where a directory to remove may lie, relative to the workspace:
 * - `sessions`: `<sessionsDir>/<slug>` (depth 1), `<slug>/<owner>` (2) or
 *   `<slug>/<owner>/<name>` (3, a session clone);
 * - `scratch`: `<scratchDir>/<slug>` (depth 1).
 * `slug`, when given, must be the first path segment.
 */
export interface WorkspaceRule {
  area: 'sessions' | 'scratch';
  depths: readonly number[];
  slug?: string | null;
}

/** Rule for a session clone of the session with this slug. */
export const cloneRule = (slug: string | null): WorkspaceRule => ({
  area: 'sessions',
  depths: [3],
  slug,
});

/** Rule for the scratch directory of the session with this slug. */
export const scratchRule = (slug: string | null): WorkspaceRule => ({
  area: 'scratch',
  depths: [1],
  slug,
});

/** A path was refused before anything was deleted. */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

/**
 * Deleting started but the directory could not be removed completely: its
 * content is gone, at least in part (a clone is no longer usable), and
 * what is left must be removed later.
 */
export class IncompleteRemovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteRemovalError';
  }
}

/** What a directory holds, read as the session user. */
export interface DirectoryContents {
  /** Disk usage in bytes (hard links within the directory counted once). */
  bytes: number;
  /** Regular files outside `.git`. */
  fileCount: number;
  /** The first of them (relative paths, sorted), at most `limit`. */
  files: string[];
  /** It has a `.git` directory. */
  git: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFER = 32 * 1024 * 1024;
/** How long processes in a removed directory get to end after SIGTERM. */
export const STOP_PROCESSES_GRACE_MS = 5000;
export const STOP_PROCESSES_SCRIPT = 'stop-processes-in.cjs';

function stopProcessesScript(): string {
  const candidates = [
    join(__dirname, 'assets', STOP_PROCESSES_SCRIPT),
    join(__dirname, '..', '..', 'assets', STOP_PROCESSES_SCRIPT),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`${STOP_PROCESSES_SCRIPT} not found`);
  }
  return found;
}

/** Names in a directory, sorted; `null` if it cannot be read. */
async function entryNames(path: string): Promise<string[] | null> {
  try {
    return (await readdir(path)).sort();
  } catch {
    return null;
  }
}

function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/**
 * Checks that `path` is a directory the app may delete under `rule`, from
 * its text alone: absolute and normalized (no `..`, `.`, double or trailing
 * slashes), strictly inside the area's root at an allowed depth, and in the
 * session's own directory when a slug is given. Returns the segments below
 * the root.
 */
export function checkLexical(
  root: string,
  path: string,
  rule: WorkspaceRule,
): string[] {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new UnsafePathError('Not a path');
  }
  if (!isAbsolute(path) || normalize(path) !== path || path.endsWith(sep)) {
    throw new UnsafePathError(`${path} is not an absolute, normalized path`);
  }
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new UnsafePathError(`${path} is not inside ${root}`);
  }
  const parts = rel.split(sep);
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new UnsafePathError(`${path} is not inside ${root}`);
  }
  if (!rule.depths.includes(parts.length)) {
    throw new UnsafePathError(
      `${path} is not a ${rule.area === 'scratch' ? 'scratch directory' : 'session directory'} of the workspace`,
    );
  }
  if (rule.slug !== undefined) {
    if (!rule.slug || parts[0] !== rule.slug) {
      throw new UnsafePathError(`${path} does not belong to this session`);
    }
  }
  return parts;
}

/** Whether `inner` is `outer` or lies inside it (lexically). */
export function isInside(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Inspects and removes directories of the workspace (session clones,
 * scratch directories, orphaned leftovers) without ever touching anything
 * outside the one directory meant.
 *
 * Before anything is deleted the path must pass {@link checkLexical}, and
 * every segment from the area's real root down must be a real directory,
 * not a symlink (so the path is its own real path). Paths from the
 * database are never trusted beyond that, and a directory that contains a
 * directory another session uses is refused.
 *
 * Deleting never runs with the API's capabilities: `find -P <path> -xdev
 * -mindepth 1 -delete` (no symlinks followed, not across filesystems)
 * runs first as the session user, who owns clones and scratch
 * directories, then as the API's user without capabilities (the
 * directories it created around clones, files it hardlinked); finally
 * `rmdir` removes the then empty directory itself. A symlink swapped in
 * after the check is removed as a link or makes `rmdir` fail; whatever a
 * race could reach is only what those unprivileged users could delete
 * anyway. In `single-user` mode all of it runs as the API's user.
 *
 * Before deleting, the session user's processes that run in the directory
 * are stopped (see {@link WorkspaceEntries.remove}).
 */
@Injectable()
export class WorkspaceEntries {
  private readonly logger = new Logger(WorkspaceEntries.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional()
    @Inject(PROCESS_LAUNCHER)
    private readonly launcher: ProcessLauncher = SINGLE_USER,
  ) {}

  /**
   * Checks `path` lexically and on disk. Resolves `false` when it does not
   * exist (nothing to do); throws {@link UnsafePathError} when it must not
   * be touched.
   */
  async verify(path: string, rule: WorkspaceRule): Promise<boolean> {
    const root =
      rule.area === 'scratch'
        ? this.config.scratchDir
        : this.config.sessionsDir;
    const parts = checkLexical(root, path, rule);
    let current: string;
    try {
      current = await realpath(root);
    } catch {
      return false;
    }
    for (const part of parts) {
      current = join(current, part);
      let stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return false;
        }
        throw error;
      }
      if (stats.isSymbolicLink()) {
        throw new UnsafePathError(
          `${path} goes through a symbolic link; it is left alone`,
        );
      }
      if (!stats.isDirectory()) {
        throw new UnsafePathError(`${path} is not a directory`);
      }
    }
    return true;
  }

  /**
   * Removes the directory `path` with everything in it (see the class
   * comment). `protectedPaths` (directories other sessions use) must not
   * lie inside it. Resolves `false` if it did not exist.
   *
   * With separate users, the session user's processes that run in it (dev
   * servers, watchers Claude started) are stopped first, except Claude
   * Code itself: they would write files again while it is deleted. If it
   * still cannot be removed, stopping and deleting are tried once more;
   * then {@link IncompleteRemovalError} tells that its content is gone, at
   * least in part (its top-level entries changed; if they did not, nothing
   * was deleted and a plain error says so: the directory stays usable).
   */
  async remove(
    path: string,
    rule: WorkspaceRule,
    protectedPaths: readonly string[] = [],
  ): Promise<boolean> {
    if (!(await this.verify(path, rule))) {
      return false;
    }
    const used = protectedPaths.find((other) => isInside(other, path));
    if (used) {
      throw new UnsafePathError(
        `${path} contains ${used}, which another session uses; it is left alone`,
      );
    }
    const args = ['-P', path, '-xdev', '-mindepth', '1', '-delete'];
    // What it held at the top, to tell whether deleting ran at all.
    const before = await entryNames(path);
    let failure = 'unknown error';
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.stopProcessesIn(path);
      // Errors are expected here (what the other user owns); `rmdir` decides.
      await this.run('session', 'find', args).catch(() => undefined);
      await this.run('api', 'find', args).catch(() => undefined);
      try {
        await this.run('api', 'rmdir', ['--', path]);
        return true;
      } catch (error) {
        failure = (error as Error).message;
      }
    }
    const after = await entryNames(path);
    if (before !== null && after !== null && sameNames(before, after)) {
      // Nothing was deleted (e.g. the commands could not be started): the
      // directory is as it was and stays usable.
      throw new Error(`${path} could not be removed: ${failure}`);
    }
    throw new IncompleteRemovalError(
      `${path} could not be removed completely: ${failure}`,
    );
  }

  /**
   * Stops the session user's processes whose working directory lies in
   * `path` (SIGTERM, then SIGKILL), except the API's direct children: the
   * Claude Code processes, which the app ends or restarts itself. Only with
   * separate users: in `single-user` mode they might be any program of the
   * developer's. A failure only means that removing may leave files.
   */
  private async stopProcessesIn(path: string): Promise<void> {
    if (!this.launcher.separated) {
      return;
    }
    try {
      const output = await this.run('session', process.execPath, [
        stopProcessesScript(),
        String(STOP_PROCESSES_GRACE_MS),
        String(process.pid),
        path,
      ]);
      const stopped = (JSON.parse(output) as { stopped?: number[] }).stopped;
      if (stopped && stopped.length > 0) {
        this.logger.log(
          `Stopped processes in ${path} before removing it: ${JSON.stringify(stopped)}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not stop the processes in ${path}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Removes what Claude Code keeps of one of its sessions in its
   * configuration directory: the transcript `projects/<project>/<id>.jsonl`
   * with its subagent directory `projects/<project>/<id>/` (in whichever
   * project directory), and `file-history/<id>`, `session-env/<id>`,
   * `tasks/<id>`. The ID must be a UUID. `find -P` locates exactly these
   * names (no symlinks followed), `rm -rf --one-file-system` removes them,
   * both as the session user, who owns Claude Code's files.
   */
  async removeClaudeSessionData(
    configDir: string,
    sdkSessionId: string,
  ): Promise<void> {
    if (!UUID.test(sdkSessionId)) {
      throw new UnsafePathError(`${sdkSessionId} is not a session ID`);
    }
    const remove = (start: string, depth: string, names: string[]) =>
      this.run('session', 'find', [
        '-P',
        start,
        '-mindepth',
        depth,
        '-maxdepth',
        depth,
        '(',
        ...names.flatMap((name, index) =>
          index === 0 ? ['-name', name] : ['-o', '-name', name],
        ),
        ')',
        '-prune',
        '-exec',
        'rm',
        '-rf',
        '--one-file-system',
        '--',
        '{}',
        '+',
      ]);
    const failures: string[] = [];
    const attempt = async (start: string, depth: string, names: string[]) => {
      try {
        await lstat(start);
      } catch {
        return; // nothing of this kind
      }
      await remove(start, depth, names).catch((error: Error) =>
        failures.push(error.message),
      );
    };
    await attempt(join(configDir, 'projects'), '2', [
      `${sdkSessionId}.jsonl`,
      sdkSessionId,
    ]);
    for (const area of ['file-history', 'session-env', 'tasks']) {
      await attempt(join(configDir, area), '1', [sdkSessionId]);
    }
    if (failures.length > 0) {
      throw new Error(
        `Claude Code's files of the session could not all be removed: ${failures.join('; ')}`,
      );
    }
  }

  /**
   * Disk usage of a directory in bytes, as the session user sees it (hard
   * links inside counted once); `null` if it does not exist.
   */
  async diskUsage(path: string, rule: WorkspaceRule): Promise<number | null> {
    if (!(await this.verify(path, rule))) {
      return null;
    }
    const du = await this.run('session', 'du', [
      '-s',
      '-x',
      '-B1',
      '--',
      path,
    ]).catch(() => '0');
    return Number.parseInt(du, 10) || 0;
  }

  /** What a directory holds (see {@link DirectoryContents}). */
  async inspect(
    path: string,
    rule: WorkspaceRule,
    limit = 50,
  ): Promise<DirectoryContents | null> {
    const bytes = await this.diskUsage(path, rule);
    if (bytes === null) {
      return null;
    }
    const listing = await this.run('session', 'find', [
      '-P',
      path,
      '-xdev',
      '-mindepth',
      '1',
      '(',
      '-name',
      '.git',
      '-prune',
      ')',
      '-o',
      '-type',
      'f',
      '-printf',
      '%P\\0',
    ]).catch(() => '');
    const files = listing.split('\0').filter(Boolean).sort();
    let git = false;
    try {
      git = (await lstat(join(path, '.git'))).isDirectory();
    } catch {
      git = false;
    }
    return {
      bytes,
      fileCount: files.length,
      files: files.slice(0, limit),
      git,
    };
  }

  private run(role: ProcessRole, command: string, args: string[]) {
    const line = this.launcher.command(role, command, args);
    return new Promise<string>((resolve, reject) => {
      execFile(
        line.command,
        line.args,
        {
          cwd: '/',
          env: { ...this.launcher.environment(role), LC_ALL: 'C' },
          timeout: COMMAND_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_BUFFER,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                stderr.trim().split('\n').slice(-3).join(' ') || error.message,
              ),
            );
          } else {
            resolve(stdout);
          }
        },
      );
    });
  }
}
