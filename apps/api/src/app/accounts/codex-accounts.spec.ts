import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SINGLE_USER } from '../common/process-isolation';
import {
  fakeCodexPids,
  fakeCodexRequests,
  processEnded,
  writeFakeCodex,
} from '../agent/codex/testing/fake-codex';
import { CodexAccounts, codexAccountStatus } from './codex-accounts';

jest.setTimeout(20_000);

const ID = '0b6f3c2e-3c1a-4b8e-9a51-2f1d1b0c9e77';
const LOGGED_OUT = {
  loggedIn: false,
  email: null,
  organization: null,
  subscriptionType: null,
  loginExpiresAt: null,
};

describe('CodexAccounts', () => {
  let dir: string;
  let base: string;
  let accounts: CodexAccounts;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crm-codex-accounts-'));
    base = join(dir, 'codex');
    mkdirSync(base);
    accounts = new CodexAccounts(writeFakeCodex(dir), base, SINGLE_USER);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const home = () => join(base, 'crm-accounts', ID);
  const account = () => ({ configDir: home(), main: false });

  describe('account homes', () => {
    it('links what all accounts share and keeps the login its own', async () => {
      writeFileSync(join(base, 'config.toml'), 'model = "gpt-5.4"\n');
      writeFileSync(join(base, 'AGENTS.md'), '# rules');
      writeFileSync(join(base, 'auth.json'), '{"main":true}');

      await expect(
        Promise.all([accounts.prepare(ID), accounts.prepare(ID)]),
      ).resolves.toEqual([home(), home()]);

      for (const name of [
        'sessions',
        'archived_sessions',
        'prompts',
        'skills',
        'rules',
      ]) {
        expect(lstatSync(join(base, name)).isDirectory()).toBe(true);
        expect(readlinkSync(join(home(), name))).toBe(join('..', '..', name));
      }
      expect(readlinkSync(join(home(), 'config.toml'))).toBe(
        join('..', '..', 'config.toml'),
      );
      expect(readFileSync(join(home(), 'AGENTS.md'), 'utf8')).toBe('# rules');
      // Only shared files the base home has; never its login.
      expect(existsSync(join(home(), 'hooks.json'))).toBe(false);
      expect(existsSync(join(home(), 'auth.json'))).toBe(false);
      expect(lstatSync(home()).mode & 0o777).toBe(0o700);

      // A conversation of the account lands in the shared sessions.
      writeFileSync(join(home(), 'sessions', 'rollout.jsonl'), '{}');
      expect(existsSync(join(base, 'sessions', 'rollout.jsonl'))).toBe(true);
      expect(accounts.path(ID)).toBe(home());
      expect(accounts.path(null)).toBe(base);
    });

    it('leaves entries Codex made itself alone', async () => {
      mkdirSync(home(), { recursive: true });
      writeFileSync(join(home(), 'config.toml'), 'own = true\n');
      writeFileSync(join(base, 'config.toml'), 'shared = true\n');
      await accounts.prepare(ID);
      expect(lstatSync(join(home(), 'config.toml')).isSymbolicLink()).toBe(
        false,
      );
      expect(readFileSync(join(home(), 'config.toml'), 'utf8')).toBe(
        'own = true\n',
      );
    });

    it('accepts a base home and shared directories that are symlinks', async () => {
      const real = join(dir, 'dotfiles-codex');
      mkdirSync(join(real, 'skills'), { recursive: true });
      writeFileSync(join(real, 'skills', 'SKILL.md'), 'skill');
      rmSync(base, { recursive: true });
      symlinkSync(real, base);
      await accounts.prepare(ID);
      expect(readFileSync(join(home(), 'skills', 'SKILL.md'), 'utf8')).toBe(
        'skill',
      );
    });

    it('refuses IDs that are no UUIDs', async () => {
      for (const id of ['../escape', 'abc', `${ID}/..`, ID.toUpperCase()]) {
        await expect(accounts.prepare(id)).rejects.toThrow(/usage/);
        await expect(accounts.remove(id)).rejects.toThrow(/usage/);
      }
      expect(existsSync(join(base, 'crm-accounts'))).toBe(false);
    });

    it('removes an account home without touching what it links to', async () => {
      writeFileSync(join(base, 'config.toml'), 'x = 1\n');
      await accounts.prepare(ID);
      writeFileSync(join(home(), 'auth.json'), '{}');
      writeFileSync(join(home(), 'sessions', 'rollout.jsonl'), '{}');

      await accounts.remove(ID);
      expect(existsSync(home())).toBe(false);
      expect(readFileSync(join(base, 'config.toml'), 'utf8')).toBe('x = 1\n');
      expect(existsSync(join(base, 'sessions', 'rollout.jsonl'))).toBe(true);
      // Again, and without any accounts directory: nothing to do.
      await accounts.remove(ID);
      rmSync(join(base, 'crm-accounts'), { recursive: true });
      await accounts.remove(ID);
    });

    it('refuses an accounts directory that is a symlink', async () => {
      const elsewhere = join(dir, 'elsewhere');
      mkdirSync(join(elsewhere, ID), { recursive: true });
      symlinkSync(elsewhere, join(base, 'crm-accounts'));
      await expect(accounts.prepare(ID)).rejects.toThrow(/not a directory/);
      await expect(accounts.remove(ID)).rejects.toThrow(/not a directory/);
      expect(existsSync(join(elsewhere, ID))).toBe(true);
    });
  });

  describe('login state', () => {
    beforeEach(() => accounts.prepare(ID));

    it('reads the status with the account’s home', async () => {
      expect(await accounts.status(account())).toEqual(LOGGED_OUT);
      writeFileSync(
        join(home(), 'auth.json'),
        JSON.stringify({
          email: 'someone@example.com',
          planType: 'pro',
          workspaceName: 'Team',
        }),
      );
      expect(await accounts.status(account())).toEqual({
        loggedIn: true,
        email: 'someone@example.com',
        organization: 'Team',
        subscriptionType: 'pro',
        loginExpiresAt: null,
      });
      expect(
        fakeCodexRequests(home())
          .filter((request) => request.method === 'account/read')
          .map((request) => request.params),
      ).toEqual([{ refreshToken: false }, { refreshToken: false }]);
      // The base home's Codex is not asked.
      expect(fakeCodexRequests(base)).toEqual([]);
    });

    it('logs out', async () => {
      writeFileSync(join(home(), 'auth.json'), '{}');
      await accounts.logout(account());
      expect(existsSync(join(home(), 'auth.json'))).toBe(false);
      expect((await accounts.status(account())).loggedIn).toBe(false);
    });

    it('fails when Codex cannot start', async () => {
      const missing = new CodexAccounts(
        join(dir, 'no-codex'),
        base,
        SINGLE_USER,
      );
      await expect(missing.status(account())).rejects.toThrow();
    });
  });

  describe('device login', () => {
    beforeEach(() => accounts.prepare(ID));

    const loginRequests = () =>
      fakeCodexRequests(home()).filter((request) =>
        request.method.startsWith('account/login/'),
      );

    it('shows the page and the code, and ends when the user entered it', async () => {
      const login = accounts.login(account());
      expect(await login.url).toBe('https://auth.openai.com/codex/device');
      expect(await login.userCode).toBe('FAKE-1234');
      expect(loginRequests()).toEqual([
        {
          method: 'account/login/start',
          params: { type: 'chatgptDeviceCode' },
        },
      ]);
      writeFileSync(
        join(home(), 'login-approve'),
        JSON.stringify({ email: 'someone@example.com', planType: 'plus' }),
      );
      expect(await login.done).toBeNull();
      expect(await accounts.status(account())).toEqual(
        expect.objectContaining({
          loggedIn: true,
          email: 'someone@example.com',
          subscriptionType: 'plus',
        }),
      );
      const [pid] = fakeCodexPids(home());
      expect(await processEnded(pid)).toBe(true);
    });

    it('reports a login Codex refused', async () => {
      const login = accounts.login(account());
      await login.userCode;
      writeFileSync(join(home(), 'login-deny'), 'The code expired');
      expect(await login.done).toBe('The code expired');
    });

    it('cancels a login with its ID', async () => {
      const login = accounts.login(account());
      await login.url;
      login.cancel();
      expect(await login.done).toBe('The login was cancelled');
      const [start, cancel] = loginRequests();
      expect(cancel).toEqual({
        method: 'account/login/cancel',
        params: { loginId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      });
      expect(start.method).toBe('account/login/start');
      const [pid] = fakeCodexPids(home());
      expect(await processEnded(pid)).toBe(true);
    });

    it('cancels a login before Codex answered, and ends Codex', async () => {
      const login = accounts.login(account());
      login.cancel();
      expect(await login.done).toBe('The login was cancelled');
      await expect(login.url).rejects.toThrow('The login was cancelled');
      await expect(login.userCode).rejects.toThrow('The login was cancelled');
      // Codex may have started meanwhile: it is ended again.
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const pid of fakeCodexPids(home())) {
        expect(await processEnded(pid)).toBe(true);
      }
    });

    it('fails when Codex cannot start', async () => {
      const missing = new CodexAccounts(
        join(dir, 'no-codex'),
        base,
        SINGLE_USER,
      );
      const login = missing.login(account());
      expect(await login.done).toEqual(expect.any(String));
      await expect(login.url).rejects.toThrow();
    });
  });
});

describe('codexAccountStatus', () => {
  it('counts only ChatGPT accounts as logged in', () => {
    expect(
      codexAccountStatus({
        account: { type: 'apiKey' },
        requiresOpenaiAuth: true,
      }),
    ).toEqual(LOGGED_OUT);
    expect(
      codexAccountStatus({ account: null, requiresOpenaiAuth: true }),
    ).toEqual(LOGGED_OUT);
    expect(
      codexAccountStatus({
        account: {
          type: 'chatgpt',
          email: '',
          planType: 'unknown',
          workspaceName: null,
        },
        requiresOpenaiAuth: true,
      }),
    ).toEqual({ ...LOGGED_OUT, loggedIn: true });
  });
});
