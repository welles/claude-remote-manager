import type { AgentAccount } from '../../agent/agent-runner';
import type { ClaudeAuthStatus, ClaudeCli, ClaudeLogin } from '../claude-cli';

/** A login started through {@link FakeClaudeCli}. */
export interface FakeLogin {
  account: AgentAccount;
  showUrl(url: string): void;
  codes: string[];
  finish(error?: string | null): void;
  cancelled: boolean;
}

/** `claude auth` without Claude Code: statuses by directory. */
export class FakeClaudeCli
  implements Pick<ClaudeCli, 'status' | 'logout' | 'login'>
{
  readonly statuses = new Map<string, ClaudeAuthStatus>();
  readonly logins: FakeLogin[] = [];
  readonly logouts: string[] = [];
  /** Makes `status` fail (e.g. a timeout). */
  statusError: Error | null = null;

  async status(account: AgentAccount): Promise<ClaudeAuthStatus> {
    if (this.statusError) {
      throw this.statusError;
    }
    return (
      this.statuses.get(account.configDir) ?? {
        loggedIn: false,
        email: null,
        organization: null,
        subscriptionType: null,
        loginExpiresAt: null,
      }
    );
  }

  async logout(account: AgentAccount): Promise<void> {
    this.logouts.push(account.configDir);
    this.statuses.delete(account.configDir);
  }

  login(account: AgentAccount): ClaudeLogin {
    let showUrl: (url: string) => void = () => undefined;
    let finish: (error: string | null) => void = () => undefined;
    const url = new Promise<string>((resolve) => {
      showUrl = resolve;
    });
    const done = new Promise<string | null>((resolve) => {
      finish = resolve;
    });
    const login: FakeLogin = {
      account,
      showUrl: (value) => showUrl(value),
      codes: [],
      finish: (error = null) => finish(error),
      cancelled: false,
    };
    this.logins.push(login);
    return {
      url,
      done,
      submit: (code) => login.codes.push(code),
      cancel: () => {
        login.cancelled = true;
        finish('cancelled');
      },
    };
  }
}
