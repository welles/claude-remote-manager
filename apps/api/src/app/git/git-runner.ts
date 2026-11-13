import { execFile, spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import {
  SINGLE_USER,
  type ProcessLauncher,
  type ProcessRole,
} from '../common/process-isolation';

/** A git command that failed; `message` ends with git's last error lines. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitRunOptions {
  /** Working directory; commands on a bare clone pass `--git-dir` instead. */
  cwd?: string;
  /** Kill git after this many ms (default: 60 s). */
  timeoutMs?: number;
  /**
   * Variables added for this command, e.g. the credentials of a
   * {@link GitAuth} (never put credentials into arguments: those are
   * visible to every process on the machine).
   */
  env?: Record<string, string>;
  /** How processes are started (users, environment); single-user by default. */
  launcher?: ProcessLauncher;
  /**
   * Who runs the command: `api` for the mirrors, `session` for commands in
   * session clones (their content is the session's, so git must not run
   * there as the API's user).
   */
  as?: ProcessRole;
}

/** Network operations (clone, fetch) may take long for big repositories. */
export const GIT_NETWORK_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Variables that would redirect git to another repository or index. They
 * may be inherited, e.g. when the API is started from a git hook.
 */
const REPOSITORY_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];

/**
 * Environment of the app's git commands: never prompt (there is no
 * terminal; missing credentials fail instead of hanging), English messages
 * for error matching, and only the transports clone URLs may use (no
 * `ext::` or other command-running transports).
 */
export function gitEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  launcher: ProcessLauncher = SINGLE_USER,
  as: ProcessRole = 'api',
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = launcher.environment(as, {}, { base });
  for (const name of REPOSITORY_VARIABLES) {
    delete env[name];
  }
  return {
    ...env,
    LC_ALL: 'C',
    LANGUAGE: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'https:ssh:file',
    GIT_SSH_COMMAND: base['GIT_SSH_COMMAND'] || 'ssh -o BatchMode=yes',
  };
}

/**
 * Options given to every git command: hooks are disabled, so creating a
 * session clone never runs scripts from a repository (`post-checkout`) in the
 * API process. Setup scripts are the only code the app runs for a
 * repository, and they run on purpose.
 */
const GLOBAL_OPTIONS = ['-c', 'core.hooksPath=/dev/null'];

const MAX_BUFFER = 64 * 1024 * 1024;

function lastLines(text: string, count = 3): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(' ');
}

/**
 * Runs git with an argument array, never through a shell. Callers put `--`
 * before paths and other values that come from users, so they cannot be
 * read as options. Resolves with stdout.
 */
export function runGit(
  args: string[],
  {
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env,
    launcher = SINGLE_USER,
    as = 'api',
  }: GitRunOptions = {},
): Promise<string> {
  const command = launcher.command(as, 'git', [...GLOBAL_OPTIONS, ...args]);
  return new Promise((resolve, reject) => {
    execFile(
      command.command,
      command.args,
      {
        cwd,
        env: { ...gitEnvironment(process.env, launcher, as), ...env },
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const command = args.find((arg) => !arg.startsWith('-')) ?? 'git';
        const detail = error.killed
          ? `timed out after ${Math.round(timeoutMs / 1000)} s`
          : lastLines(stderr) || error.message;
        reject(
          new GitError(
            `git ${command} failed: ${detail}`,
            args,
            typeof error.code === 'number' ? error.code : null,
            stderr,
          ),
        );
      },
    );
  });
}

/**
 * Runs git and writes its stdout into a new file (e.g. a bundle), as
 * {@link runGit} does otherwise. The file is created by the API; the git
 * process only writes to the pipe.
 */
export async function runGitToFile(
  args: string[],
  file: string,
  {
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    launcher = SINGLE_USER,
    as = 'api',
  }: GitRunOptions = {},
): Promise<void> {
  const handle = await open(file, 'wx', 0o600);
  const output = handle.createWriteStream();
  const command = launcher.command(as, 'git', [...GLOBAL_OPTIONS, ...args]);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.command, command.args, {
        cwd,
        env: gitEnvironment(process.env, launcher, as),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.pipe(output, { end: false });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4000);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          output.on('finish', resolve);
          output.end();
        } else {
          const name = args.find((arg) => !arg.startsWith('-')) ?? 'git';
          reject(
            new GitError(
              `git ${name} failed: ${lastLines(stderr) || `exit ${code}`}`,
              args,
              code,
              stderr,
            ),
          );
        }
      });
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Another git process holds a lock git needs (a ref, `packed-refs`, the
 * index or the shallow file). The app serializes its own commands per
 * mirror, but git may still meet a stale lock or another git process.
 */
export function isLockContention(error: unknown): boolean {
  return (
    error instanceof GitError &&
    /cannot lock ref|unable to create '[^']*\.lock'|unable to lock|\.lock': file exists/i.test(
      error.stderr,
    )
  );
}

/** Retries an operation a few times while git reports lock contention. */
export async function retryOnLockContention<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[] = [100, 400, 1500],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= delaysMs.length || !isLockContention(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}
