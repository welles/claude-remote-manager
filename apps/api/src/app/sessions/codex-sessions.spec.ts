import { join } from 'node:path';
import type { SessionDto } from '@claude-remote-manager/shared-types';
import type { AccountBackend } from '../accounts/account-backend';
import { CHATGPT_ACCOUNTS } from '../accounts/accounts.service';
import { AgentEngines, CODEX_CAPABILITIES } from '../agent/agent-engines';
import { DATABASE, type AppDatabase } from '../db/database';
import { accounts } from '../db/schema';
import { rawRequest, startTestApp, type TestApp } from '../testing/test-app';
import { NO_GITHUB_REASON } from './session-agent-support';
import { AccountsService } from '../accounts/accounts.service';
import { SessionManagementService } from './session-management.service';
import { SessionRepository } from './session.repository';
import {
  LIMIT_SWITCH_CONTINUE_TEXT,
  SessionsService,
} from './sessions.service';
import {
  FakeAgentRunner,
  FakeTranscriptReader,
  resultMessage,
  waitFor,
} from './testing/fake-agent';

/** Codex's reader: removes a deleted session's thread. */
class CodexReader extends FakeTranscriptReader {
  readonly removed: string[] = [];
  readonly looked: string[] = [];

  override async exists(id: string): Promise<boolean> {
    this.looked.push(id);
    return super.exists(id);
  }

  async remove(threadId: string): Promise<void> {
    this.removed.push(threadId);
  }
}

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
  let reader: CodexReader;
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
    reader = new CodexReader();
    app.app.get(AgentEngines).register('codex', {
      runner: codex,
      transcripts: reader,
      capabilities: CODEX_CAPABILITIES,
      fixedTools: true,
      namesSessions: true,
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
      sessionAllows: [],
      // Codex names its threads: nothing to look up for a new session.
      resume: null,
    });
    expect(reader.looked).toEqual([]);

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

  it('removes the thread of a deleted session', async () => {
    const session = (await create({ engine: 'codex' })).json<SessionDto>();
    await waitFor(() => codex.runs.length === 1);
    codex.last.emit(
      {
        type: 'system',
        subtype: 'init',
        session_id: '01a22115-9256-7822-87d8-50c911ae76b2',
      },
      resultMessage(1, 0, {
        session_id: '01a22115-9256-7822-87d8-50c911ae76b2',
      }),
    );
    await waitFor(
      () =>
        app.app.get(SessionRepository).get(session.id)?.sdkSessionId ===
        '01a22115-9256-7822-87d8-50c911ae76b2',
    );
    await app.app.get(SessionsService).end(session.id);
    await app.app
      .get(SessionManagementService)
      .delete(session.id, { confirm: true, acceptLoss: true });
    expect(reader.removed).toEqual(['01a22115-9256-7822-87d8-50c911ae76b2']);
  });

  it('removes a ChatGPT account also without Codex on the server', async () => {
    // As if Codex were gone: the backend is not there any more.
    const accounts = app.app.get(AccountsService) as unknown as {
      chatgpt: unknown;
    };
    accounts.chatgpt = null;
    const removed = await call('DELETE', '/api/accounts/chatgpt-b');
    expect(removed.status).toBe(204);
    expect(
      app.app
        .get(AccountsService)
        .list()
        .map((account) => account.id),
    ).not.toContain('chatgpt-b');
  });

  it('starts the next process only after the closed one has ended', async () => {
    const session = (await create({ engine: 'codex' })).json<SessionDto>();
    await waitFor(() => codex.runs.length === 1);
    codex.last.emit(resultMessage(1, 0));
    await waitFor(
      async () =>
        (await call('GET', `/api/sessions/${session.id}`)).json<SessionDto>()
          .status === 'waiting',
    );
    let exited: () => void = () => undefined;
    codex.last.exit = new Promise((resolve) => (exited = resolve));
    // Another account: the process is closed and the next one resumes the
    // thread in the other home, never while the old one still writes it.
    expect(
      (
        await call('PATCH', `/api/sessions/${session.id}`, {
          accountId: 'chatgpt-b',
        })
      ).status,
    ).toBe(200);
    await waitFor(() => codex.runs[0].closed);
    await call('POST', `/api/sessions/${session.id}/messages`, {
      text: 'Next',
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(codex.runs).toHaveLength(1);
    exited();
    await waitFor(() => codex.runs.length === 2);
    expect(codex.last.options.account?.configDir).toBe(
      join(homes, 'chatgpt-b'),
    );
  });

  it('fails visibly when no ChatGPT account is left', async () => {
    const session = (await create({ engine: 'codex' })).json<SessionDto>();
    await waitFor(() => codex.runs.length === 1);
    codex.last.emit(resultMessage(1, 0));
    await waitFor(
      async () =>
        (await call('GET', `/api/sessions/${session.id}`)).json<SessionDto>()
          .status === 'waiting',
    );
    codex.last.close();
    await waitFor(() => codex.runs[0].closed);
    for (const id of ['chatgpt-a', 'chatgpt-b']) {
      expect((await call('DELETE', `/api/accounts/${id}`)).status).toBe(204);
    }
    await call('POST', `/api/sessions/${session.id}/messages`, {
      text: 'Next',
    });
    // Not stuck in `running`: the start fails and says why.
    await waitFor(
      async () =>
        (await call('GET', `/api/sessions/${session.id}`)).json<SessionDto>()
          .status === 'failed',
    );
    expect(codex.runs).toHaveLength(1);
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
