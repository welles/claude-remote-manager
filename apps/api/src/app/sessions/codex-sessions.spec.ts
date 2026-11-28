import { join } from 'node:path';
import type { SessionDto } from '@claude-remote-manager/shared-types';
import type { AccountBackend } from '../accounts/account-backend';
import { CHATGPT_ACCOUNTS } from '../accounts/accounts.service';
import { AgentEngines, CODEX_CAPABILITIES } from '../agent/agent-engines';
import { DATABASE, type AppDatabase } from '../db/database';
import { accounts } from '../db/schema';
import { rawRequest, startTestApp, type TestApp } from '../testing/test-app';
import { NO_GITHUB_REASON } from './session-agent-support';
import { LIMIT_SWITCH_CONTINUE_TEXT } from './sessions.service';
import {
  FakeAgentRunner,
  FakeTranscriptReader,
  resultMessage,
  waitFor,
} from './testing/fake-agent';

const LOGGED_IN = {
  loggedIn: true,
  email: null,
  organization: null,
  subscriptionType: 'plus',
  loginExpiresAt: null,
};

/**
 * Codex sessions in the engine-neutral core: a fake engine registered as
 * `codex` (as the module registers the Codex adapter), with ChatGPT
 * accounts whose homes are only paths.
 */
describe('Codex sessions', () => {
  let app: TestApp;
  let codex: FakeAgentRunner;
  let homes: string;

  beforeEach(async () => {
    const backend: AccountBackend = {
      path: (directory) => join(homes, directory ?? ''),
      prepare: async () => undefined,
      remove: async () => undefined,
      status: async () => LOGGED_IN,
      logout: async () => undefined,
      login: () => {
        throw new Error('no logins here');
      },
    };
    app = await startTestApp(
      {},
      {
        configure: (builder) =>
          builder.overrideProvider(CHATGPT_ACCOUNTS).useValue(backend),
      },
    );
    homes = join(app.dir, 'codex');
    codex = new FakeAgentRunner();
    app.app.get(AgentEngines).register('codex', {
      runner: codex,
      transcripts: new FakeTranscriptReader(),
      capabilities: CODEX_CAPABILITIES,
      fixedTools: true,
    });
    const db = app.app.get<AppDatabase>(DATABASE);
    for (const [id, name, position] of [
      ['chatgpt-a', 'Plus', 1],
      ['chatgpt-b', 'Pro', 2],
    ] as const) {
      db.insert(accounts)
        .values({
          id,
          provider: 'chatgpt',
          name,
          position,
          directory: id,
          isDefault: id === 'chatgpt-a',
          loggedIn: true,
        })
        .run();
    }
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

  const create = async (body: Record<string, unknown>) =>
    call('POST', '/api/sessions', { prompt: 'Hi', scratch: true, ...body });

  it('creates sessions in Codex’s own modes, untrusted by default', async () => {
    const created = await create({ engine: 'codex' });
    expect(created.status).toBe(201);
    const session = created.json<SessionDto>();
    expect(session).toMatchObject({
      engine: 'codex',
      permissionMode: 'untrusted',
      accountId: 'chatgpt-a',
    });
    await waitFor(() => codex.runs.length === 1);
    expect(app.runner.runs).toHaveLength(0);
    expect(codex.last.options).toMatchObject({
      permissionMode: 'untrusted',
      account: { configDir: join(homes, 'chatgpt-a'), main: false },
      usageBaseline: {},
    });

    // Another engine's modes are refused, at creation and later.
    expect(
      (await create({ engine: 'codex', permissionMode: 'default' })).status,
    ).toBe(400);
    expect(
      (await create({ engine: 'claude-code', permissionMode: 'untrusted' }))
        .status,
    ).toBe(400);
    expect(
      (
        await call('PATCH', `/api/sessions/${session.id}`, {
          permissionMode: 'bypassPermissions',
        })
      ).status,
    ).toBe(400);
    const changed = await call('PATCH', `/api/sessions/${session.id}`, {
      permissionMode: 'never',
    });
    expect(changed.status).toBe(200);
    expect(changed.json<SessionDto>().permissionMode).toBe('never');
    // A Claude Code account does not run a Codex session.
    expect(
      (await create({ engine: 'codex', accountId: 'main' })).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it('gives Codex every app tool, those it cannot use now marked, and Claude Code only usable ones', async () => {
    await create({ engine: 'codex', title: 'Chosen' });
    await waitFor(() => codex.runs.length === 1);
    const tools = codex.last.options.tools ?? [];
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    // A scratch session has no GitHub repository: registered, refusing.
    for (const name of [
      'create_pull_request',
      'reply_to_review_thread',
      'merge_pull_request',
      'set_pr_automation',
      'request_owner_decision',
    ]) {
      expect(byName.get(name)?.unavailable).toBe(NO_GITHUB_REASON);
    }
    // A title the user chose: the tool stays and refuses by itself.
    expect(byName.get('set_session_title')?.unavailable).toBeUndefined();
    const title = await byName
      .get('set_session_title')
      ?.handler({ title: 'Other' }, { toolUseId: null });
    expect(title?.text).toMatch(/chose the title "Chosen"/);
    expect(byName.get('show_file')?.unavailable).toBeUndefined();

    await create({ title: 'Chosen' });
    await waitFor(() => app.runner.runs.length === 1);
    const claudeTools = (app.runner.last.options.tools ?? []).map(
      (tool) => tool.name,
    );
    expect(claudeTools).not.toContain('create_pull_request');
    expect(claudeTools).not.toContain('set_session_title');
    expect(
      (app.runner.last.options.tools ?? []).some((tool) => tool.unavailable),
    ).toBe(false);
  });

  it('switches to the next ChatGPT account at the usage limit', async () => {
    const session = (await create({ engine: 'codex' })).json<SessionDto>();
    await waitFor(() => codex.runs.length === 1);
    codex.probeUsage = () =>
      ({
        subscription_type: 'plus',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 10, resets_at: null },
          seven_day: null,
          seven_day_opus: null,
          seven_day_sonnet: null,
          seven_day_oauth_apps: null,
        },
      }) as never;
    codex.last.emit(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          resetsAt: Math.floor((Date.now() + 3_600_000) / 1000),
          rateLimitType: 'five_hour',
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'rate_limit',
        message: {
          id: 'limit',
          content: [{ type: 'text', text: "You've hit your usage limit." }],
        },
      },
      resultMessage(1, 0, {
        is_error: true,
        result: "You've hit your usage limit.",
      }),
    );
    await waitFor(() => codex.runs.length === 2);
    // The other ChatGPT account, never a Claude account.
    expect(codex.last.options.account).toEqual({
      configDir: join(homes, 'chatgpt-b'),
      main: false,
    });
    expect(codex.last.sent[0].text).toBe(LIMIT_SWITCH_CONTINUE_TEXT);
    expect(app.runner.runs).toHaveLength(0);
    const after = (
      await call('GET', `/api/sessions/${session.id}`)
    ).json<SessionDto>();
    expect(after.accountId).toBe('chatgpt-b');
  });
});
