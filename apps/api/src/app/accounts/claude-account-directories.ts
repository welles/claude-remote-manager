import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProcessLauncher } from '../common/process-isolation';

/** Directory of the further accounts inside the main directory. */
export const ACCOUNTS_DIRECTORY = 'crm-accounts';

/** The helper that does the work as the session user. */
export const ACCOUNT_DIR_SCRIPT = 'claude-account-dir.cjs';

const HELPER_TIMEOUT_MS = 30_000;

/** Path of the helper script (next to the bundle, or in the sources). */
export function accountDirScript(): string {
  const candidates = [
    join(__dirname, 'assets', ACCOUNT_DIR_SCRIPT),
    join(__dirname, '..', '..', 'assets', ACCOUNT_DIR_SCRIPT),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`${ACCOUNT_DIR_SCRIPT} not found`);
  }
  return found;
}

/**
 * Claude Code configuration directories of the accounts. The main account
 * uses the main directory (`~/.claude` or `CLAUDE_CONFIG_DIR`); every
 * further account has `<main>/crm-accounts/<id>` with its own login and
 * state file, and a symlink into the main directory for everything else,
 * so that settings, skills, plugins, memory and transcripts are the same
 * for all accounts. The user's MCP servers are managed in the main
 * account and copied into the others.
 *
 * The directories belong to the session user (who runs Claude Code): the
 * helper `claude-account-dir.cjs` creates and removes them as that user,
 * so that the API never writes into them with its own privileges.
 * Requests for the same account run one after the other.
 */
export class ClaudeAccountDirectories {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    /** The main directory. */
    readonly mainDir: string,
    private readonly launcher: ProcessLauncher,
    /**
     * Claude Code's state file of the main directory: `.claude.json` in
     * it when `CLAUDE_CONFIG_DIR` is set, else `~/.claude.json`.
     */
    private readonly mainStateFile: string,
  ) {}

  /** For the API's environment (see `claudeConfigDir`). */
  static forEnvironment(
    launcher: ProcessLauncher,
    env: NodeJS.ProcessEnv = process.env,
  ): ClaudeAccountDirectories {
    const configured = env['CLAUDE_CONFIG_DIR'];
    const home = launcher.sessionUser?.home ?? homedir();
    const mainDir = configured || join(home, '.claude');
    return new ClaudeAccountDirectories(
      mainDir,
      launcher,
      configured
        ? join(configured, '.claude.json')
        : join(home, '.claude.json'),
    );
  }

  /** The directory of an account (`null`: the main one). */
  path(directory: string | null): string {
    return directory === null
      ? this.mainDir
      : join(this.mainDir, ACCOUNTS_DIRECTORY, directory);
  }

  /**
   * Creates the directory of a further account (or completes it): the
   * shared entries as symlinks, the user's MCP servers in its state file.
   */
  async prepare(directory: string): Promise<string> {
    await this.serialized(directory, () =>
      this.helper(['prepare', this.mainDir, this.mainStateFile, directory]),
    );
    return this.path(directory);
  }

  /** Removes the directory of a further account (symlinks, not targets). */
  remove(directory: string): Promise<void> {
    return this.serialized(directory, () =>
      this.helper(['remove', this.mainDir, directory]),
    );
  }

  private serialized(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.queues.set(key, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.queues.get(key) === next) {
          this.queues.delete(key);
        }
      });
    return next;
  }

  private helper(args: string[]): Promise<void> {
    const command = this.launcher.command('session', process.execPath, [
      accountDirScript(),
      ...args,
    ]);
    return new Promise((resolve, reject) => {
      execFile(
        command.command,
        command.args,
        {
          cwd: '/',
          env: this.launcher.environment('session'),
          timeout: HELPER_TIMEOUT_MS,
          maxBuffer: 64 * 1024,
        },
        (error, stdout) => {
          let result: { ok?: boolean; message?: string } | null = null;
          try {
            result = JSON.parse(String(stdout).trim().split('\n').at(-1) ?? '');
          } catch {
            result = null;
          }
          if (result?.ok) {
            resolve();
          } else {
            reject(
              new Error(
                `Preparing the account directory failed: ${result?.message ?? error?.message ?? 'no answer'}`,
              ),
            );
          }
        },
      );
    });
  }
}
