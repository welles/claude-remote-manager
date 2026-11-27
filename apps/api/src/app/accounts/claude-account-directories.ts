import {
  lchown,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProcessLauncher } from '../common/process-isolation';

/** Directory of the further accounts inside the main directory. */
export const ACCOUNTS_DIRECTORY = 'crm-accounts';

/**
 * Entries of the main directory that belong to one account and are never
 * shared: the login, Claude Code's state file (account, onboarding, per
 * project trust) and its backups, the app's own account directories.
 */
const OWN_ENTRIES: ReadonlySet<string> = new Set([
  '.credentials.json',
  '.claude.json',
  'backups',
  ACCOUNTS_DIRECTORY,
  'statsig',
  '.last-cleanup',
]);

/**
 * Shared directories created in the main directory if missing, so that
 * Claude Code of another account does not create its own: the transcripts
 * (so that a session can switch accounts and resume), the user's
 * configuration and Claude Code's per-session state.
 */
const SHARED_DIRECTORIES: readonly string[] = [
  'projects',
  'skills',
  'plugins',
  'agents',
  'commands',
  'todos',
  'tasks',
  'plans',
  'session-env',
  'shell-snapshots',
  'file-history',
];

function isOwnEntry(name: string): boolean {
  return OWN_ENTRIES.has(name) || name.startsWith('.claude.json');
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Claude Code configuration directories of the accounts. The main account
 * uses the main directory (`~/.claude` or `CLAUDE_CONFIG_DIR`); every
 * further account has `<main>/crm-accounts/<name>` with its own login and
 * state file, and a symlink into the main directory for everything else,
 * so that settings, skills, plugins, memory and transcripts are the same
 * for all accounts.
 *
 * The directories belong to the session user (who runs Claude Code); in
 * `separate-users` mode the API creates them and hands them over.
 */
export class ClaudeAccountDirectories {
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
    const root = join(this.mainDir, ACCOUNTS_DIRECTORY);
    const dir = this.path(directory);
    await this.makeDirectory(this.mainDir);
    await this.makeDirectory(root);
    await this.makeDirectory(dir);
    for (const name of SHARED_DIRECTORIES) {
      await this.makeDirectory(join(this.mainDir, name));
    }
    for (const name of await readdir(this.mainDir)) {
      if (isOwnEntry(name)) {
        continue;
      }
      const link = join(dir, name);
      try {
        await lstat(link);
        // A symlink, or an entry Claude Code created itself: left alone.
        continue;
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          throw error;
        }
      }
      // Relative, so that the directory keeps working when the volume is
      // mounted elsewhere.
      await symlink(join('..', '..', name), link);
      await this.handOver(link);
    }
    await this.copyMcpServers(dir);
    return dir;
  }

  /** Removes the directory of a further account (symlinks, not targets). */
  async remove(directory: string): Promise<void> {
    await rm(this.path(directory), { recursive: true, force: true });
  }

  /**
   * The user's MCP servers (`mcpServers` of the main state file) in the
   * state file of the account, so that sessions of every account have
   * them. Written only when they differ.
   */
  private async copyMcpServers(dir: string): Promise<void> {
    const main = await readJson(this.mainStateFile);
    if (main === INVALID) {
      return;
    }
    const servers = main?.['mcpServers'];
    const file = join(dir, '.claude.json');
    const existing = await readJson(file);
    if (existing === INVALID) {
      // Being written by Claude Code, or broken: not overwritten.
      return;
    }
    const state = existing ?? {};
    if (
      JSON.stringify(state['mcpServers'] ?? null) ===
      JSON.stringify(servers ?? null)
    ) {
      return;
    }
    if (servers === undefined) {
      delete state['mcpServers'];
    } else {
      state['mcpServers'] = servers;
    }
    const temporary = `${file}.crm-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await this.handOver(temporary);
    await rename(temporary, file);
  }

  private async makeDirectory(path: string): Promise<void> {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        return;
      }
      throw error;
    }
    await this.handOver(path);
  }

  private async handOver(path: string): Promise<void> {
    const user = this.launcher.sessionUser;
    if (user) {
      await lchown(path, user.uid, user.gid);
    }
  }
}

/** A state file that exists but is no JSON object. */
const INVALID = Symbol('invalid');

async function readJson(
  file: string,
): Promise<Record<string, unknown> | null | typeof INVALID> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : INVALID;
  } catch {
    return INVALID;
  }
}
