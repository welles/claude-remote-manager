import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessLauncher } from '../common/process-isolation';
import type { AgentAccount } from '../agent/agent-runner';
import { accountEnvironment } from '../agent/sdk-agent-runner';

/** What `claude auth status --json` says about an account. */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email: string | null;
  organization: string | null;
  subscriptionType: string | null;
  loginExpiresAt: string | null;
}

/** How long a login may wait for the user's code. */
export const LOGIN_TIMEOUT_MS = 15 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 64 * 1024;

/**
 * The Claude Code executable the sessions run: `CLAUDE_CODE_EXECUTABLE`,
 * else the Agent SDK's bundled binary for this platform (as the SDK finds
 * it), else `claude` on the PATH.
 */
export function resolveClaudeExecutable(configured: string | null): string {
  if (configured) {
    return configured;
  }
  const from = process.argv[1] || join(process.cwd(), 'index.js');
  const require = createRequire(from);
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const name of [`${base}/claude`, `${base}-musl/claude`]) {
    try {
      return require.resolve(name);
    } catch {
      // not installed
    }
  }
  return 'claude';
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** Parses the JSON of `claude auth status` (exit code 1 when logged out). */
export function parseAuthStatus(output: string): ClaudeAuthStatus {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error(
      `Unexpected answer of claude auth status: ${output.trim()}`,
    );
  }
  const value = JSON.parse(output.slice(start, end + 1)) as Record<
    string,
    unknown
  >;
  return {
    loggedIn: value['loggedIn'] === true,
    email: text(value['email']),
    organization: text(value['orgName']),
    subscriptionType: text(value['subscriptionType']),
    loginExpiresAt: text(value['loginExpiresAt']),
  };
}

/** The page to open from the output of `claude auth login`. */
export function loginUrl(output: string): string | null {
  const match = /https:\/\/\S*oauth\/authorize\S*/.exec(output);
  return match ? match[0] : null;
}

/** A running `claude auth login`. */
export interface ClaudeLogin {
  /** Resolves with the login page as soon as Claude Code prints it. */
  url: Promise<string>;
  /** Sends the code the user copied from the browser. */
  submit(code: string): void;
  /** Resolves when the process ended: `null` on success, else why not. */
  done: Promise<string | null>;
  cancel(): void;
}

/**
 * Runs Claude Code's `auth` commands for an account, as the session user
 * and with the account's directory, like a session process.
 */
export class ClaudeCli {
  constructor(
    private readonly executable: string,
    private readonly launcher: ProcessLauncher,
  ) {}

  async status(account: AgentAccount): Promise<ClaudeAuthStatus> {
    const result = await this.run(account, ['auth', 'status', '--json']);
    return parseAuthStatus(result.output);
  }

  async logout(account: AgentAccount): Promise<void> {
    const result = await this.run(account, ['auth', 'logout']);
    if (result.code !== 0) {
      throw new Error(result.output.trim() || 'claude auth logout failed');
    }
  }

  /**
   * Starts `claude auth login` (subscription login): Claude Code prints
   * the login URL and reads the code from stdin; no terminal needed.
   */
  login(account: AgentAccount): ClaudeLogin {
    const child = this.spawn(account, ['auth', 'login', '--claudeai']);
    let output = '';
    let resolveUrl: (url: string) => void = () => undefined;
    let rejectUrl: (error: Error) => void = () => undefined;
    const url = new Promise<string>((resolve, reject) => {
      resolveUrl = resolve;
      rejectUrl = reject;
    });
    // Unhandled when nobody waits for it any more.
    url.catch(() => undefined);
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT);
      const found = loginUrl(output);
      if (found) {
        resolveUrl(found);
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGTERM'), LOGIN_TIMEOUT_MS);
    const done = new Promise<string | null>((resolve) => {
      child.on('error', (error) => {
        clearTimeout(timer);
        rejectUrl(error);
        resolve(error.message);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        rejectUrl(new Error(lastLines(output) || 'claude auth login ended'));
        resolve(
          code === 0
            ? null
            : lastLines(output) ||
                (signal
                  ? `claude auth login was stopped (${signal})`
                  : `claude auth login failed (exit code ${code})`),
        );
      });
    });
    return {
      url,
      submit: (code) => {
        child.stdin?.write(`${code.trim()}\n`);
      },
      done,
      cancel: () => {
        child.kill('SIGTERM');
      },
    };
  }

  private run(
    account: AgentAccount,
    args: string[],
  ): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(account, args);
      child.stdin?.end();
      let output = '';
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  }

  private spawn(account: AgentAccount, args: string[]): ChildProcess {
    const command = this.launcher.command('session', this.executable, args);
    return spawn(command.command, command.args, {
      // Readable for the session user; nothing is written there.
      cwd: tmpdir(),
      env: accountEnvironment(
        this.launcher,
        // No browser on the server: Claude Code shows the URL instead.
        { BROWSER: 'true' },
        account,
        process.env,
      ),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}

/** The last lines of a command's output, for an error message. */
function lastLines(output: string): string {
  return output
    .split('\n')
    .map((line) => line.replace(/^.*Paste code here if prompted >/, '').trim())
    .filter(
      (line) =>
        line &&
        !line.includes('oauth/authorize') &&
        !line.startsWith('Opening browser'),
    )
    .slice(-3)
    .join('\n');
}
