import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  AccountDto,
  AccountListResponse,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { LimitsService } from '../limits/limits.service';
import { SessionRepository } from '../sessions/session.repository';
import {
  LIMIT_SWITCH_CONTINUE_TEXT,
  limitSwitchNotice,
  SessionsService,
} from '../sessions/sessions.service';
import { AccountsService, LOGIN_STALE_MS } from './accounts.service';
import { resultMessage, waitFor } from '../sessions/testing/fake-agent';
import { rawRequest, startTestApp, type TestApp } from '../testing/test-app';

describe('accounts', () => {
  let app: TestApp;
  let mainDir: string;

  beforeEach(async () => {
    app = await startTestApp();
    mainDir = join(app.dir, 'claude');
  });
  afterEach(() => app.close());

  const call = (method: string, path: string, body?: unknown) =>
    rawRequest(
      app.port,
      method,
      path,
      body === undefined ? {} : { 'content-type': 'application/json' },
      body === undefined ? undefined : JSON.stringify(body),
    );
  const list = async () =>
    (await call('GET', '/api/accounts')).json<AccountListResponse>().accounts;
  const loggedIn = (email: string) => ({
    loggedIn: true,
    email,
    organization: null,
    subscriptionType: 'max',
    loginExpiresAt: null,
  });

  /** Adds an account through the login in the UI. */
  const addAccount = async (name: string, email: string) => {
    const created = (
      await call('POST', '/api/accounts', { name })
    ).json<AccountDto>();
    const login = app.claudeCli.logins.at(-1);
    if (!login) {
      throw new Error('no login started');
    }
    login.showUrl('https://claude.com/cai/oauth/authorize?code=true');
    await waitFor(
      async () =>
        (await list()).find((a) => a.id === created.id)?.login?.status ===
        'waiting',
    );
    const coded = await call('POST', `/api/accounts/${created.id}/login/code`, {
      code: 'abc#def',
    });
    expect(coded.status).toBe(201);
    expect(login.codes).toEqual(['abc#def']);
    app.claudeCli.statuses.set(login.account.configDir, loggedIn(email));
    login.finish();
    await waitFor(
      async () =>
        (await list()).find((a) => a.id === created.id)?.login?.status ===
        'done',
    );
    return created;
  };

  it('lists the main account with its login state', async () => {
    app.claudeCli.statuses.set(mainDir, loggedIn('main@example.test'));
    await call('POST', '/api/accounts/main/refresh');
    const [main] = await list();
    expect(main).toMatchObject({
      id: 'main',
      main: true,
      isDefault: true,
      loggedIn: true,
      email: 'main@example.test',
      subscriptionType: 'max',
      limits: { accountId: 'main', windows: [] },
    });
    // The main account cannot be removed, only logged out.
    expect((await call('DELETE', '/api/accounts/main')).status).toBe(409);
    expect((await call('POST', '/api/accounts/main/logout')).status).toBe(201);
    expect(app.claudeCli.logouts).toEqual([mainDir]);
    expect((await list())[0].loggedIn).toBe(false);
  });

  it('adds an account with its own login and shared configuration', async () => {
    mkdirSync(join(mainDir, 'skills'), { recursive: true });
    writeFileSync(join(mainDir, 'settings.json'), '{}');
    writeFileSync(
      join(mainDir, '.claude.json'),
      JSON.stringify({
        mcpServers: { docs: { command: 'docs' } },
        userID: 'x',
      }),
    );
    writeFileSync(join(mainDir, '.credentials.json'), '{}');

    const account = await addAccount('Work', 'work@example.test');
    const [, added] = await list();
    expect(added).toMatchObject({
      id: account.id,
      name: 'Work',
      main: false,
      isDefault: false,
      loggedIn: true,
      email: 'work@example.test',
      position: 1,
      login: { status: 'done', error: null },
    });

    const dir = app.claudeCli.logins[0].account.configDir;
    expect(dir).toBe(join(mainDir, 'crm-accounts', account.id));
    expect(app.claudeCli.logins[0].account.main).toBe(false);
    // Shared through symlinks; the login and state file are its own.
    expect(readlinkSync(join(dir, 'settings.json'))).toBe(
      join('..', '..', 'settings.json'),
    );
    expect(lstatSync(join(dir, 'projects')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, 'skills')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))).toEqual(
      {
        mcpServers: { docs: { command: 'docs' } },
      },
    );

    // Renamed, made the default, moved to the front.
    await call('PATCH', `/api/accounts/${account.id}`, {
      name: 'Work (Max)',
      isDefault: true,
    });
    await call('PUT', '/api/accounts/order', { ids: [account.id, 'main'] });
    expect((await list()).map((a) => [a.name, a.isDefault])).toEqual([
      ['Work (Max)', true],
      ['Claude', false],
    ]);
    expect(
      (await call('PUT', '/api/accounts/order', { ids: ['main'] })).status,
    ).toBe(400);
  });

  it('reports a failed or cancelled login', async () => {
    const created = (
      await call('POST', '/api/accounts', { name: 'Other' })
    ).json<AccountDto>();
    expect(
      (
        await call('POST', `/api/accounts/${created.id}/login/code`, {
          code: 'x',
        })
      ).status,
    ).toBe(409);
    app.claudeCli.logins[0].finish('Invalid code');
    await waitFor(async () => (await list())[1].login?.status === 'failed');
    expect((await list())[1].login?.error).toBe('Invalid code');

    await call('POST', `/api/accounts/${created.id}/login`);
    expect(app.claudeCli.logins).toHaveLength(2);
    await call('DELETE', `/api/accounts/${created.id}/login`);
    expect(app.claudeCli.logins[1].cancelled).toBe(true);
    expect((await list())[1].login).toBeNull();
  });

  it('runs sessions with their account and switches it', async () => {
    app.claudeCli.statuses.set(mainDir, loggedIn('main@example.test'));
    await call('POST', '/api/accounts/main/refresh');
    const account = await addAccount('Work', 'work@example.test');
    const dir = join(mainDir, 'crm-accounts', account.id);

    const session = (
      await call('POST', '/api/sessions', {
        prompt: 'Hi',
        scratch: true,
        accountId: account.id,
      })
    ).json<SessionDto>();
    expect(session.accountId).toBe(account.id);
    await waitFor(() => app.runner.runs.length === 1);
    expect(app.runner.last.options.account).toEqual({
      configDir: dir,
      main: false,
    });

    // Without a choice: the default account, unless its limit is exhausted.
    const plain = (
      await call('POST', '/api/sessions', { prompt: 'Hi', scratch: true })
    ).json<SessionDto>();
    expect(plain.accountId).toBe('main');
    app.app
      .get(LimitsService)
      .account('main')
      .updateFromRateLimitEvent({
        status: 'rejected',
        rateLimitType: 'five_hour',
        resetsAt: Date.now() / 1000 + 3600,
      });
    const avoiding = (
      await call('POST', '/api/sessions', { prompt: 'Hi', scratch: true })
    ).json<SessionDto>();
    expect(avoiding.accountId).toBe(account.id);

    // Switched: stored now, used by the next process.
    const switched = await call('PATCH', `/api/sessions/${session.id}`, {
      accountId: 'main',
    });
    expect(switched.json<SessionDto>().accountId).toBe('main');
    expect(
      (
        await call('PATCH', `/api/sessions/${session.id}`, {
          accountId: 'nope',
        })
      ).status,
    ).toBe(400);

    // Removed: its sessions fall back to the default account.
    await call('PATCH', `/api/sessions/${session.id}`, {
      accountId: account.id,
    });
    // Not while a running process uses it.
    expect((await call('DELETE', `/api/accounts/${account.id}`)).status).toBe(
      409,
    );
    await call('POST', `/api/sessions/${session.id}/end`);
    await call('POST', `/api/sessions/${avoiding.id}/end`);
    let status = 0;
    await waitFor(async () => {
      status = (await call('DELETE', `/api/accounts/${account.id}`)).status;
      return status !== 409;
    });
    expect(status).toBe(204);
    expect(existsSync(dir)).toBe(false);
    const after = (
      await call('GET', `/api/sessions/${session.id}`)
    ).json<SessionDto>();
    expect(after.accountId).toBeNull();
    expect((await list()).map((a) => a.id)).toEqual(['main']);
  });

  it('continues a session waiting for its limit as soon as it switches to an account with room', async () => {
    app.claudeCli.statuses.set(mainDir, loggedIn('main@example.test'));
    await call('POST', '/api/accounts/main/refresh');
    const account = await addAccount('Work', 'work@example.test');
    const session = (
      await call('POST', '/api/sessions', {
        prompt: 'Hi',
        scratch: true,
        accountId: 'main',
      })
    ).json<SessionDto>();
    await waitFor(() => app.runner.runs.length === 1);
    const resetsAt = Date.now() + 5 * 3_600_000;
    app.runner.last.emit(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          resetsAt: Math.floor(resetsAt / 1000),
          rateLimitType: 'five_hour',
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'rate_limit',
        message: {
          id: 'limit',
          content: [{ type: 'text', text: "You've hit your 5-hour limit" }],
        },
      },
      resultMessage(1, 0, {
        is_error: true,
        result: "You've hit your 5-hour limit",
      }),
    );
    const get = async () =>
      (await call('GET', `/api/sessions/${session.id}`)).json<SessionDto>();
    await waitFor(async () => (await get()).waitingFor === 'limit');

    // The other account has room (the probe answers for it).
    app.runner.probeUsage = () =>
      ({
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 10, resets_at: null },
          seven_day: null,
          seven_day_opus: null,
          seven_day_sonnet: null,
          seven_day_oauth_apps: null,
        },
      }) as never;
    await call('PATCH', `/api/sessions/${session.id}`, {
      accountId: account.id,
    });
    await waitFor(() => app.runner.runs.length === 2);
    expect(app.runner.last.options.account).toEqual({
      configDir: join(mainDir, 'crm-accounts', account.id),
      main: false,
    });
    expect((await get()).waitingFor).not.toBe('limit');
  });

  it('validates a change completely before writing it', async () => {
    const account = await addAccount('Work', 'work@example.test');
    const response = await call('PATCH', `/api/accounts/${account.id}`, {
      name: 'Renamed',
      isDefault: false,
    });
    expect(response.status).toBe(400);
    expect((await list())[1].name).toBe('Work');
  });

  it('reads login states again once they are old (a login from a terminal)', async () => {
    const service = app.app.get(AccountsService);
    await waitFor(async () => (await list())[0].loggedIn === false);
    app.claudeCli.statuses.set(mainDir, loggedIn('main@example.test'));
    // Fresh: not read again.
    service.refreshIfStale(Date.now());
    expect((await list())[0].loggedIn).toBe(false);
    service.refreshIfStale(Date.now() + LOGIN_STALE_MS);
    await waitFor(async () => (await list())[0].loggedIn === true);
  });

  it('keeps an account a review or probe uses until it is done', async () => {
    const account = await addAccount('Work', 'work@example.test');
    const service = app.app.get(AccountsService);
    const state: { finish: (() => void) | null } = { finish: null };
    const using = service.withAccount(account.id, (used) => {
      expect(used.configDir).toBe(join(mainDir, 'crm-accounts', account.id));
      return new Promise<void>((resolve) => {
        state.finish = resolve;
      });
    });
    await waitFor(() => state.finish !== null);
    expect((await call('DELETE', `/api/accounts/${account.id}`)).status).toBe(
      409,
    );
    state.finish?.();
    await using;
    expect((await call('DELETE', `/api/accounts/${account.id}`)).status).toBe(
      204,
    );
    // Gone: probes for it fail instead of using another account.
    await expect(
      service.withAccount(account.id, async () => 'x', { exact: true }),
    ).rejects.toThrow();
  });

  it('continues with the account the session was switched to during the turn the limit ended', async () => {
    app.claudeCli.statuses.set(mainDir, loggedIn('main@example.test'));
    await call('POST', '/api/accounts/main/refresh');
    const account = await addAccount('Work', 'work@example.test');
    const session = (
      await call('POST', '/api/sessions', {
        prompt: 'Hi',
        scratch: true,
        accountId: 'main',
      })
    ).json<SessionDto>();
    await waitFor(() => app.runner.runs.length === 1);
    // Switched while the turn runs; then the old account's limit ends it.
    await call('PATCH', `/api/sessions/${session.id}`, {
      accountId: account.id,
    });
    app.runner.probeUsage = () =>
      ({
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 10, resets_at: null },
          seven_day: null,
          seven_day_opus: null,
          seven_day_sonnet: null,
          seven_day_oauth_apps: null,
        },
      }) as never;
    app.runner.last.emit(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          resetsAt: Math.floor((Date.now() + 5 * 3_600_000) / 1000),
          rateLimitType: 'five_hour',
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'rate_limit',
        message: {
          id: 'limit',
          content: [{ type: 'text', text: "You've hit your 5-hour limit" }],
        },
      },
      resultMessage(1, 0, {
        is_error: true,
        result: "You've hit your 5-hour limit",
      }),
    );
    await waitFor(() => app.runner.runs.length === 2);
    expect(app.runner.last.options.account).toEqual({
      configDir: join(mainDir, 'crm-accounts', account.id),
      main: false,
    });
  });

  it('keeps the account when the rest of a session change is refused', async () => {
    const account = await addAccount('Work', 'work@example.test');
    const session = (
      await call('POST', '/api/sessions', {
        prompt: 'Hi',
        scratch: true,
        accountId: 'main',
      })
    ).json<SessionDto>();
    await waitFor(() => app.runner.runs.length === 1);
    app.runner.last.failSwitch = new Error('model not available');
    const response = await call('PATCH', `/api/sessions/${session.id}`, {
      accountId: account.id,
      model: 'opus',
    });
    expect(response.status).toBe(409);
    expect(
      (await call('GET', `/api/sessions/${session.id}`)).json<SessionDto>()
        .accountId,
    ).toBe('main');
  });

  it('takes over limit waits from before accounts without dropping their window', async () => {
    const session = (
      await call('POST', '/api/sessions', { prompt: 'Hi', scratch: true })
    ).json<SessionDto>();
    await waitFor(() => app.runner.runs.length === 1);
    const repository = app.app.get(SessionRepository);
    const wait = {
      since: new Date().toISOString(),
      window: 'model:Fable',
      resumeAt: new Date(Date.now() + 86_400_000).toISOString(),
      resetKnown: true,
      autofixPullRequests: [],
    };
    repository.update(session.id, { status: 'waiting', limitWait: wait });
    // Any change of the accounts makes waiting sessions look at theirs.
    await call('PATCH', '/api/accounts/main', { name: 'Main' });
    expect(repository.require(session.id).limitWait).toEqual({
      ...wait,
      accountId: 'main',
    });
  });

  it('does not restart the process when the session switches away and back during a turn', async () => {
    const account = await addAccount('Work', 'work@example.test');
    const session = (
      await call('POST', '/api/sessions', {
        prompt: 'Hi',
        scratch: true,
        accountId: 'main',
      })
    ).json<SessionDto>();
    await waitFor(() => app.runner.runs.length === 1);
    await call('PATCH', `/api/sessions/${session.id}`, {
      accountId: account.id,
    });
    await call('PATCH', `/api/sessions/${session.id}`, { accountId: 'main' });
    app.runner.last.emit(resultMessage(1, 0));
    const get = async () =>
      (await call('GET', `/api/sessions/${session.id}`)).json<SessionDto>();
    await waitFor(async () => (await get()).status === 'waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.runner.last.closed).toBe(false);
    expect(app.runner.runs).toHaveLength(1);
  });

  it('reports a login Claude Code confirmed as done even when its status cannot be read', async () => {
    const created = (
      await call('POST', '/api/accounts', { name: 'Work' })
    ).json<AccountDto>();
    app.claudeCli.statusError = new Error('timed out');
    app.claudeCli.logins[0].finish();
    await waitFor(
      async () =>
        (await list()).find((a) => a.id === created.id)?.login?.status ===
        'done',
    );
  });

  it('does not restart the process after switching through several accounts back to its own', async () => {
    const work = await addAccount('Work', 'work@example.test');
    const other = await addAccount('Other', 'other@example.test');
    const session = (
      await call('POST', '/api/sessions', {
        prompt: 'Hi',
        scratch: true,
        accountId: 'main',
      })
    ).json<SessionDto>();
    await waitFor(() => app.runner.runs.length === 1);
    for (const accountId of [work.id, other.id, 'main']) {
      await call('PATCH', `/api/sessions/${session.id}`, { accountId });
    }
    app.runner.last.emit(resultMessage(1, 0));
    await waitFor(
      async () =>
        (await call('GET', `/api/sessions/${session.id}`)).json<SessionDto>()
          .status === 'waiting',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.runner.last.closed).toBe(false);
    expect(app.runner.runs).toHaveLength(1);
  });

  describe('automatic switch at the limit', () => {
    /** `type` `null`: a limit Claude Code reported without its window. */
    const hitLimit = (resetsAtMs: number, type: string | null = 'five_hour') =>
      app.runner.last.emit(
        ...(type === null
          ? []
          : [
              {
                type: 'rate_limit_event',
                rate_limit_info: {
                  status: 'rejected',
                  resetsAt: Math.floor(resetsAtMs / 1000),
                  rateLimitType: type,
                },
              },
            ]),
        {
          type: 'assistant',
          parent_tool_use_id: null,
          error: 'rate_limit',
          message: {
            id: 'limit',
            content: [{ type: 'text', text: "You've hit your 5-hour limit" }],
          },
        },
        resultMessage(1, 0, {
          is_error: true,
          result: "You've hit your 5-hour limit",
        }),
      );
    const usage = (percent: number, resetsAt: string | null) =>
      ({
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: percent, resets_at: resetsAt },
          seven_day: null,
          seven_day_opus: null,
          seven_day_sonnet: null,
          seven_day_oauth_apps: null,
        },
      }) as never;
    const events = async (sessionId: string) => {
      const sessions = app.app.get(SessionsService);
      return (await sessions.subscribe(sessionId)).events;
    };

    it('continues the turn with the next account that has room', async () => {
      app.claudeCli.statuses.set(mainDir, loggedIn('main@example.test'));
      await call('POST', '/api/accounts/main/refresh');
      const work = await addAccount('Work', 'work@example.test');
      const session = (
        await call('POST', '/api/sessions', {
          prompt: 'Hi',
          scratch: true,
          accountId: 'main',
        })
      ).json<SessionDto>();
      await waitFor(() => app.runner.runs.length === 1);
      app.runner.probeUsage = () => usage(10, null);
      hitLimit(Date.now() + 5 * 3_600_000);

      await waitFor(() => app.runner.runs.length === 2);
      expect(app.runner.last.options.account).toEqual({
        configDir: join(mainDir, 'crm-accounts', work.id),
        main: false,
      });
      expect(app.runner.last.sent[0].text).toBe(LIMIT_SWITCH_CONTINUE_TEXT);
      const after = (
        await call('GET', `/api/sessions/${session.id}`)
      ).json<SessionDto>();
      expect(after.accountId).toBe(work.id);
      expect(await events(session.id)).toContainEqual(
        expect.objectContaining({
          type: 'notice',
          text: limitSwitchNotice('Claude', 'Work'),
        }),
      );
    });

    it('waits for the account that resets first when every account is exhausted', async () => {
      app.claudeCli.statuses.set(mainDir, loggedIn('main@example.test'));
      await call('POST', '/api/accounts/main/refresh');
      const work = await addAccount('Work', 'work@example.test');
      const soon = Date.now() + 3_600_000;
      app.app
        .get(LimitsService)
        .account(work.id)
        .updateFromRateLimitEvent({
          status: 'rejected',
          rateLimitType: 'five_hour',
          resetsAt: Math.floor(soon / 1000),
        });
      const session = (
        await call('POST', '/api/sessions', {
          prompt: 'Hi',
          scratch: true,
          accountId: 'main',
        })
      ).json<SessionDto>();
      await waitFor(() => app.runner.runs.length === 1);
      app.runner.probeUsage = () => usage(100, new Date(soon).toISOString());
      hitLimit(Date.now() + 5 * 3_600_000);

      const get = async () =>
        (await call('GET', `/api/sessions/${session.id}`)).json<SessionDto>();
      await waitFor(async () => {
        const dto = await get();
        return (
          dto.accountId === work.id &&
          dto.waitingFor === 'limit' &&
          dto.limitResetKnown === true
        );
      });
      const resumes = Date.parse((await get()).limitResumesAt ?? '');
      expect(resumes).toBeGreaterThan(soon - 1000);
      expect(resumes).toBeLessThan(soon + 5 * 60_000);
      expect(app.runner.runs).toHaveLength(1);
    });

    const mainLoggedIn = async () => {
      app.claudeCli.statuses.set(mainDir, loggedIn('main@example.test'));
      await call('POST', '/api/accounts/main/refresh');
    };
    const startOn = async (accountId: string) => {
      const session = (
        await call('POST', '/api/sessions', {
          prompt: 'Hi',
          scratch: true,
          accountId,
        })
      ).json<SessionDto>();
      await waitFor(() => app.runner.runs.length >= 1);
      return session;
    };
    const get = async (id: string) =>
      (await call('GET', `/api/sessions/${id}`)).json<SessionDto>();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

    it('does not switch to an account exhausted on the same per-model window', async () => {
      await mainLoggedIn();
      const work = await addAccount('Work', 'work@example.test');
      const later = Date.now() + 3 * 86_400_000;
      app.app
        .get(LimitsService)
        .account(work.id)
        .updateFromRateLimitEvent({
          status: 'rejected',
          rateLimitType: 'seven_day_opus',
          resetsAt: Math.floor(later / 1000),
        });
      const session = await startOn('main');
      hitLimit(Date.now() + 86_400_000, 'seven_day_opus');
      await waitFor(async () => (await get(session.id)).waitingFor === 'limit');
      await settle();
      expect((await get(session.id)).accountId).toBe('main');
      expect(app.runner.runs).toHaveLength(1);
    });

    it('tries each account once until a turn gets through', async () => {
      await mainLoggedIn();
      const work = await addAccount('Work', 'work@example.test');
      app.runner.probeUsage = () => usage(10, null);
      const session = await startOn('main');
      // Limits without their window: nothing marks an account exhausted.
      hitLimit(Date.now(), null);
      await waitFor(() => app.runner.runs.length === 2);
      expect((await get(session.id)).accountId).toBe(work.id);
      hitLimit(Date.now(), null);
      await waitFor(async () => (await get(session.id)).waitingFor === 'limit');
      await settle();
      expect(app.runner.runs).toHaveLength(2);
      expect((await get(session.id)).accountId).toBe(work.id);
    });

    it('keeps the account the user chose during the turn', async () => {
      await mainLoggedIn();
      const work = await addAccount('Work', 'work@example.test');
      const other = await addAccount('Other', 'other@example.test');
      app.runner.probeUsage = () => usage(10, null);
      const session = await startOn('main');
      await call('PATCH', `/api/sessions/${session.id}`, {
        accountId: other.id,
      });
      hitLimit(Date.now() + 3_600_000);
      await waitFor(() => app.runner.runs.length === 2);
      expect((await get(session.id)).accountId).toBe(other.id);
      expect(app.runner.last.options.account?.configDir).toBe(
        join(mainDir, 'crm-accounts', other.id),
      );
      expect(work.id).not.toBe(other.id);
    });

    it('goes ahead with the new account when its limits cannot be read', async () => {
      await mainLoggedIn();
      await addAccount('Work', 'work@example.test');
      app.runner.probeUsage = () => {
        throw new Error('usage not available');
      };
      await startOn('main');
      hitLimit(Date.now() + 3_600_000);
      await waitFor(() => app.runner.runs.length === 2);
    });

    it('goes back to the original account when it resets before the one switched to', async () => {
      await mainLoggedIn();
      const work = await addAccount('Work', 'work@example.test');
      const soon = Date.now() + 30 * 60_000;
      // Work's limits are unknown until read: then its week is used up.
      app.runner.probeUsage = () =>
        ({
          subscription_type: 'max',
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 10, resets_at: null },
            seven_day: {
              utilization: 100,
              resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString(),
            },
            seven_day_opus: null,
            seven_day_sonnet: null,
            seven_day_oauth_apps: null,
          },
        }) as never;
      const session = await startOn('main');
      hitLimit(soon);
      await waitFor(async () => {
        const dto = await get(session.id);
        return dto.accountId === 'main' && dto.limitResetKnown === true;
      });
      const resumes = Date.parse((await get(session.id)).limitResumesAt ?? '');
      expect(resumes).toBeLessThan(soon + 5 * 60_000);
      expect(app.runner.runs).toHaveLength(1);
      expect(work.id).toBeTruthy();
    });

    it('stays with the only account', async () => {
      const session = (
        await call('POST', '/api/sessions', { prompt: 'Hi', scratch: true })
      ).json<SessionDto>();
      await waitFor(() => app.runner.runs.length === 1);
      hitLimit(Date.now() + 3_600_000);
      const get = async () =>
        (await call('GET', `/api/sessions/${session.id}`)).json<SessionDto>();
      await waitFor(async () => (await get()).waitingFor === 'limit');
      expect((await get()).accountId).toBe('main');
    });
  });
});
