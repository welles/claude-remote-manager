import type { AgentAccount } from '../agent/agent-runner';

/** What a provider's login says about an account. */
export interface AccountStatus {
  loggedIn: boolean;
  email: string | null;
  organization: string | null;
  subscriptionType: string | null;
  loginExpiresAt: string | null;
}

/**
 * A login started in the UI: the page to open, and either a code the user
 * copies from it (`submit`) or a code the user enters there (`userCode`,
 * a device login).
 */
export interface AccountLogin {
  url: Promise<string>;
  /** For a device login: the code to enter on the page. */
  userCode?: Promise<string>;
  /** For a login that ends with a code from the page. */
  submit?(code: string): void;
  /** `null` on success, else why not. */
  done: Promise<string | null>;
  cancel(): void;
}

/**
 * How the accounts of one provider live on this machine: their
 * directories (the engine's configuration home with the login) and their
 * login, status and logout.
 */
export interface AccountBackend {
  /** The directory of an account (`null`: the provider's main one). */
  path(directory: string | null): string;
  prepare(directory: string): Promise<unknown>;
  remove(directory: string): Promise<void>;
  status(account: AgentAccount): Promise<AccountStatus>;
  logout(account: AgentAccount): Promise<void>;
  login(account: AgentAccount): AccountLogin;
}
