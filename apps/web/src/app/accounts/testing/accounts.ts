import type {
  AccountDto,
  AccountListResponse,
} from '@claude-remote-manager/shared-types';

/** An account as the API returns it; the main account by default. */
export function accountDto(overrides: Partial<AccountDto> = {}): AccountDto {
  const id = overrides.id ?? 'main';
  return {
    id,
    provider: 'claude',
    name: 'Claude',
    position: 0,
    isDefault: true,
    main: id === 'main',
    loggedIn: true,
    email: 'me@example.test',
    organization: null,
    subscriptionType: 'max',
    loginExpiresAt: null,
    limits: {
      accountId: id,
      windows: [],
      subscriptionType: null,
      updatedAt: null,
    },
    login: null,
    ...overrides,
  };
}

/** `GET /api/accounts` with only the main account. */
export function mainAccountList(): AccountListResponse {
  return { accounts: [accountDto()] };
}
