import type { AccountLimits } from './limits';

/**
 * Accounts the sessions work with. Each Claude account has a Claude Code
 * configuration directory of its own with a full login; the first one is
 * the main directory (`~/.claude` or `CLAUDE_CONFIG_DIR`), which also holds
 * everything the accounts share (transcripts, settings, skills, plugins).
 * Only subscription logins, no API keys.
 */
export type AccountProvider = 'claude' | 'chatgpt';

export const ACCOUNT_PROVIDERS: readonly AccountProvider[] = ['claude', 'chatgpt'];

/** ID of the account of the main Claude directory; it cannot be removed. */
export const MAIN_ACCOUNT_ID = 'main';

export const MAX_ACCOUNT_NAME_LENGTH = 60;

/**
 * A login started in the UI: `starting` until the login URL is known,
 * `waiting` for the code the user copies from the browser, `verifying`
 * after the code was sent, then `done` or `failed` (with `error`).
 */
export type AccountLoginStatus =
  | 'starting'
  | 'waiting'
  | 'verifying'
  | 'done'
  | 'failed';

export interface AccountLoginDto {
  status: AccountLoginStatus;
  /** The page to open in the browser, once known. */
  url: string | null;
  error: string | null;
}

export interface AccountDto {
  id: string;
  provider: AccountProvider;
  name: string;
  /** Order for the automatic switch and the lists (0 first). */
  position: number;
  /** Preselected for new sessions. */
  isDefault: boolean;
  /** The account of the main Claude directory (cannot be removed). */
  main: boolean;
  /** `null` until checked. */
  loggedIn: boolean | null;
  email: string | null;
  organization: string | null;
  /** e.g. `max`, `pro`. */
  subscriptionType: string | null;
  /** When the login must be renewed (ISO 8601), when known. */
  loginExpiresAt: string | null;
  limits: AccountLimits;
  /** A login in progress (or just ended) from the UI. */
  login: AccountLoginDto | null;
}

export interface AccountListResponse {
  accounts: AccountDto[];
}

export interface CreateAccountRequest {
  provider?: AccountProvider;
  name: string;
}

export interface UpdateAccountRequest {
  name?: string;
  /** Only `true`: makes this the default account. */
  isDefault?: true;
}

export interface ReorderAccountsRequest {
  /** All account IDs in the new order. */
  ids: string[];
}

export interface AccountLoginCodeRequest {
  code: string;
}

/** Live update of all accounts (logins, limits, changes). */
export interface AccountsChangedMessage {
  type: 'accounts.changed';
  accounts: AccountDto[];
}

/** How the UI names a provider's accounts. */
export const ACCOUNT_PROVIDER_LABELS: Record<AccountProvider, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
};
