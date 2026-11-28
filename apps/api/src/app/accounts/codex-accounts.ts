import { Logger } from '@nestjs/common';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessLauncher } from '../common/process-isolation';
import type { AgentAccount } from '../agent/agent-runner';
import { CodexAppServer } from '../agent/codex/codex-app-server';
import type { CodexAccountResponse } from '../agent/codex/codex-protocol';
import type {
  AccountBackend,
  AccountLogin,
  AccountStatus,
} from './account-backend';
import {
  ACCOUNTS_DIRECTORY,
  runAccountHelper,
  SerialQueues,
} from './claude-account-directories';
import { LOGIN_TIMEOUT_MS } from './claude-cli';

/** The helper that creates and removes Codex homes as the session user. */
export const CODEX_ACCOUNT_DIR_SCRIPT = 'codex-account-dir.cjs';

/** What `account/read` says, as the accounts show it. */
export function codexAccountStatus(
  response: CodexAccountResponse,
): AccountStatus {
  const account = response.account;
  if (account?.type !== 'chatgpt' || !('planType' in account)) {
    return {
      loggedIn: false,
      email: null,
      organization: null,
      subscriptionType: null,
      loginExpiresAt: null,
    };
  }
  return {
    loggedIn: true,
    email: account.email || null,
    organization: account.workspaceName || null,
    subscriptionType:
      account.planType && account.planType !== 'unknown'
        ? account.planType
        : null,
    // Codex renews its tokens itself.
    loginExpiresAt: null,
  };
}

/**
 * The ChatGPT accounts: each has its own Codex home
 * `<base>/crm-accounts/<id>` with its login (`auth.json`) and state, and
 * links to what all share in the base home (configuration, instructions,
 * skills, conversations). Login, status and logout go through Codex's app
 * server with the account's home, as the session user; the login is
 * ChatGPT's device login (a page and a code to enter there).
 */
export class CodexAccounts implements AccountBackend {
  private readonly logger = new Logger(CodexAccounts.name);
  private readonly queues = new SerialQueues();

  constructor(
    private readonly executable: string,
    /** The shared Codex home (see `codexBaseHome`). */
    readonly baseHome: string,
    private readonly launcher: ProcessLauncher,
  ) {}

  path(directory: string | null): string {
    return directory === null
      ? this.baseHome
      : join(this.baseHome, ACCOUNTS_DIRECTORY, directory);
  }

  /**
   * Prepares the account's home; what the helper warns about (a shared
   * file the account has a copy of its own of) is logged.
   */
  async prepare(directory: string): Promise<string> {
    await this.queues.run(directory, async () => {
      const warnings = await runAccountHelper(
        this.launcher,
        CODEX_ACCOUNT_DIR_SCRIPT,
        ['prepare', this.baseHome, directory],
      );
      for (const warning of warnings) {
        this.logger.warn(`ChatGPT account ${directory}: ${warning}`);
      }
    });
    return this.path(directory);
  }

  remove(directory: string): Promise<void> {
    return this.queues.run(directory, async () => {
      await runAccountHelper(this.launcher, CODEX_ACCOUNT_DIR_SCRIPT, [
        'remove',
        this.baseHome,
        directory,
      ]);
    });
  }

  async status(account: AgentAccount): Promise<AccountStatus> {
    return this.withServer(account, async (server) =>
      codexAccountStatus(
        await server.request<CodexAccountResponse>('account/read', {
          refreshToken: false,
        }),
      ),
    );
  }

  async logout(account: AgentAccount): Promise<void> {
    await this.withServer(account, (server) =>
      server.request('account/logout', undefined),
    );
  }

  login(account: AgentAccount): AccountLogin {
    let resolveUrl: (url: string) => void = () => undefined;
    let resolveCode: (code: string) => void = () => undefined;
    let rejectStart: (error: Error) => void = () => undefined;
    const url = new Promise<string>((resolve, reject) => {
      resolveUrl = resolve;
      rejectStart = reject;
    });
    const userCode = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      const previous = rejectStart;
      rejectStart = (error) => {
        previous(error);
        reject(error);
      };
    });
    // Unhandled when nobody waits for them any more.
    url.catch(() => undefined);
    userCode.catch(() => undefined);

    let server: CodexAppServer | null = null;
    let loginId: string | null = null;
    let finished = false;
    let cancelled = false;
    let resolveDone: (result: string | null) => void = () => undefined;
    const done = new Promise<string | null>((resolve) => {
      resolveDone = resolve;
    });
    const finish = (result: string | null) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      rejectStart(new Error(result ?? 'The login ended'));
      resolveDone(result);
      server?.close();
    };
    const timer = setTimeout(
      () => finish('The login was not completed in time'),
      LOGIN_TIMEOUT_MS,
    );
    timer.unref?.();

    void (async () => {
      try {
        server = await CodexAppServer.start({
          executable: this.executable,
          launcher: this.launcher,
          home: account.configDir,
          cwd: tmpdir(),
          onNotification: (method, params) => {
            if (method !== 'account/login/completed') {
              return;
            }
            const result = params as {
              loginId: string | null;
              success: boolean;
              error: string | null;
            };
            if (
              loginId !== null &&
              result.loginId &&
              result.loginId !== loginId
            ) {
              return;
            }
            finish(result.success ? null : result.error || 'The login failed');
          },
          onExit: (error) => {
            if (error) {
              finish(error.message);
            }
          },
        });
        if (finished) {
          server.close();
          return;
        }
        const started = await server.request<{
          type: string;
          loginId: string;
          verificationUrl: string;
          userCode: string;
        }>('account/login/start', { type: 'chatgptDeviceCode' });
        loginId = started.loginId;
        if (cancelled) {
          await this.cancelOn(server, loginId);
          finish('The login was cancelled');
          return;
        }
        resolveUrl(started.verificationUrl);
        resolveCode(started.userCode);
      } catch (error) {
        finish(error instanceof Error ? error.message : String(error));
      }
    })();

    return {
      url,
      userCode,
      done,
      cancel: () => {
        cancelled = true;
        if (server && loginId !== null) {
          void this.cancelOn(server, loginId).finally(() =>
            finish('The login was cancelled'),
          );
        } else if (!server) {
          finish('The login was cancelled');
        }
      },
    };
  }

  private async cancelOn(server: CodexAppServer, loginId: string) {
    try {
      await server.request('account/login/cancel', { loginId });
    } catch {
      // Ends with the process anyway.
    }
  }

  private async withServer<T>(
    account: AgentAccount,
    task: (server: CodexAppServer) => Promise<T>,
  ): Promise<T> {
    const server = await CodexAppServer.start({
      executable: this.executable,
      launcher: this.launcher,
      home: account.configDir,
      cwd: tmpdir(),
    });
    try {
      return await task(server);
    } finally {
      server.close();
    }
  }
}
