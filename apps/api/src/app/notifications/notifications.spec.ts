import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type {
  ApprovalActionResult,
  NotificationStatusDto,
  PushSubscriptionDto,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { AccountsService } from '../accounts/accounts.service';
import { SESSIONS_WS_PATH } from '../sessions/sessions.gateway';
import { SessionsService } from '../sessions/sessions.service';
import { flush, resultMessage, waitFor } from '../sessions/testing/fake-agent';
import {
  postJson,
  rawRequest,
  startTestApp,
  type TestApp,
} from '../testing/test-app';
import { shortId } from './notification';
import { NotificationsService } from './notifications.service';
import { NTFY_FETCH } from './ntfy.channel';
import { SessionNotifier } from './session-notifier';
import { FakeNtfy, RecordingPushSender } from './testing/fakes';
import { PushSender } from './web-push.channel';

const TOKEN = 'tk_notificationtesttoken0123456';
const KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString(
  'base64url',
);
const AUTH = Buffer.alloc(16, 3).toString('base64url');
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';
const STALL_MS = 10 * 60_000;

describe('notifications', () => {
  let app: TestApp;
  let secrets: string;
  let push: RecordingPushSender;
  let ntfy: FakeNtfy;
  let notifier: SessionNotifier;
  let service: NotificationsService;

  beforeEach(async () => {
    secrets = mkdtempSync(join(tmpdir(), 'crm-secrets-'));
    writeFileSync(join(secrets, 'ntfy-token'), TOKEN);
    push = new RecordingPushSender();
    ntfy = new FakeNtfy();
    app = await startTestApp(
      {
        notifications: {
          publicUrl: 'https://crm.example.com',
          stallMs: STALL_MS,
          ntfy: {
            server: 'https://ntfy.example.com',
            topic: 'crm',
            tokenFile: join(secrets, 'ntfy-token'),
          },
          vapid: { publicKey: null, privateKeyFile: null, subject: null },
        },
      },
      {
        identity: false,
        configure: (builder) =>
          builder
            .overrideProvider(PushSender)
            .useValue(push)
            .overrideProvider(NTFY_FETCH)
            .useValue(ntfy.fetch),
      },
    );
    notifier = app.app.get(SessionNotifier);
    service = app.app.get(NotificationsService);
  });
  afterEach(async () => {
    await app.close();
    rmSync(secrets, { recursive: true, force: true });
  });

  const json = <T>(response: { json<U>(): U }) => response.json<T>();
  const subscribe = (
    body: unknown,
    userAgent = 'Mozilla/5.0 (Linux; Android 15) Chrome/140.0',
  ) =>
    postJson(app.port, '/api/notifications/push-subscriptions', body, {
      'user-agent': userAgent,
    });
  const device = () =>
    subscribe({ endpoint: ENDPOINT, keys: { p256dh: KEY, auth: AUTH } });

  const createSession = async (): Promise<SessionDto> => {
    const runs = app.runner.runs.length;
    const response = await postJson(app.port, '/api/sessions', {
      prompt: 'Fix the login',
      scratch: true,
    });
    expect(response.status).toBe(201);
    await waitFor(() => app.runner.runs.length > runs);
    await flush();
    return response.json<SessionDto>();
  };

  const requestApproval = async (input: Record<string, unknown>) => {
    const before = push.sent.length;
    const decision = app.runner.last.options.canUseTool('Bash', input, {
      signal: new AbortController().signal,
      toolUseID: 't1',
      requestId: 'x',
    });
    await waitFor(() => push.sent.length > before);
    await service.settled();
    // Wrapped: an async function returning the promise would wait for it.
    return { decision };
  };

  const finishTurn = async (
    text: string,
    extra: Record<string, unknown> = {},
  ) => {
    app.runner.last.emit(
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { id: `m-${text}`, content: [{ type: 'text', text }] },
      },
      resultMessage(1, 0, extra),
    );
    await flush();
    await flush();
    await service.settled();
  };

  it('reports channels and devices without secrets', async () => {
    const status = json<NotificationStatusDto>(
      await rawRequest(app.port, 'GET', '/api/notifications'),
    );
    expect(status).toMatchObject({
      stallMinutes: 10,
      publicUrl: 'https://crm.example.com',
      webPush: { problem: null, subscriptions: [] },
      ntfy: {
        configured: true,
        server: 'https://ntfy.example.com',
        topic: 'crm',
        tokenSet: true,
        problem: null,
      },
    });
    expect(status.webPush.vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(status.preferences.approval).toEqual({ webPush: true, ntfy: true });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(JSON.stringify(status)).not.toContain('privateKey');
  });

  it('registers devices once per endpoint and removes them', async () => {
    const first = await device();
    expect(first.status).toBe(201);
    expect(first.json<PushSubscriptionDto>()).toMatchObject({
      label: 'Chrome on Android',
      pushService: 'fcm.googleapis.com',
    });
    expect((await device()).json<PushSubscriptionDto>().id).toBe(
      first.json<PushSubscriptionDto>().id,
    );
    for (const endpoint of [
      'http://fcm.googleapis.com/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://localhost/x',
      'https://printer.local/x',
      'https://intranet/x',
      'not a url',
    ]) {
      const response = await subscribe({
        endpoint,
        keys: { p256dh: KEY, auth: AUTH },
      });
      expect([endpoint, response.status]).toEqual([endpoint, 400]);
    }
    expect(
      (
        await subscribe({
          endpoint: ENDPOINT,
          keys: { p256dh: 'abc', auth: AUTH },
        })
      ).status,
    ).toBe(400);
    // Only JSON bodies, as everywhere.
    expect(
      (
        await rawRequest(
          app.port,
          'POST',
          '/api/notifications/push-subscriptions',
          { 'content-type': 'application/x-www-form-urlencoded' },
          'endpoint=x',
        )
      ).status,
    ).toBe(415);
    const removed = await postJson(
      app.port,
      '/api/notifications/push-subscriptions/remove',
      { endpoint: ENDPOINT },
    );
    expect(removed.status).toBe(204);
    expect(
      json<NotificationStatusDto>(
        await rawRequest(app.port, 'GET', '/api/notifications'),
      ).webPush.subscriptions,
    ).toEqual([]);
    expect(
      (
        await rawRequest(
          app.port,
          'DELETE',
          '/api/notifications/push-subscriptions/unknown',
        )
      ).status,
    ).toBe(404);
  });

  it('changes the preferences per event and channel', async () => {
    const put = (body: unknown) =>
      rawRequest(
        app.port,
        'PUT',
        '/api/notifications/preferences',
        { 'content-type': 'application/json' },
        JSON.stringify(body),
      );
    const changed = await put({ preferences: { stalled: { ntfy: false } } });
    expect(changed.status).toBe(200);
    expect(json<NotificationStatusDto>(changed).preferences.stalled).toEqual({
      webPush: true,
      ntfy: false,
    });
    expect((await put({ preferences: { nope: {} } })).status).toBe(400);
    expect(
      (await put({ preferences: { stalled: { email: true } } })).status,
    ).toBe(400);
    expect(
      (await put({ preferences: { stalled: { ntfy: 'no' } } })).status,
    ).toBe(400);
  });

  it('sends test notifications per channel', async () => {
    const test = (channel: string) =>
      postJson(app.port, '/api/notifications/test', { channel });
    expect((await test('webPush')).json()).toEqual({
      ok: false,
      message:
        'No device is subscribed. Enable notifications on this device first.',
    });
    await device();
    expect((await test('webPush')).json()).toEqual({
      ok: true,
      message: 'Sent to 1 device.',
    });
    expect((await test('ntfy')).json()).toMatchObject({ ok: true });
    expect(ntfy.requests[0].headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    ntfy.respond = () =>
      new Response('{"error":"unauthorized"}', { status: 401 });
    const refused = (await test('ntfy')).json<{
      ok: boolean;
      message: string;
    }>();
    expect(refused.ok).toBe(false);
    expect(refused.message).not.toContain(TOKEN);
    expect((await test('email')).status).toBe(400);
  });

  it('notifies about approvals and answers them once from the notification', async () => {
    await device();
    const session = await createSession();
    const { decision } = await requestApproval({ command: 'npm test' });
    const [shown] = push.payloads('show');
    expect(shown).toMatchObject({
      type: 'show',
      title: 'Approve? Run a command',
      body: 'npm test\nFix the login · scratch',
      url: `/sessions/${session.id}`,
      sessionId: session.id,
      actions: ['allow', 'deny'],
      badge: 1,
    });
    expect(ntfy.messages[0]).toMatchObject({
      title: 'Approve? Run a command',
      message: 'npm test\nFix the login · scratch',
      priority: 4,
      click: `https://crm.example.com/sessions/${session.id}`,
    });
    const requestId = shown.type === 'show' ? (shown.requestId as string) : '';

    const action = (body: unknown) =>
      postJson(app.port, '/api/notifications/approval-actions', body);
    // Other sessions' or unknown requests are not reachable this way.
    expect(
      (
        await action({
          sessionId: session.id,
          requestId: '00000000-0000-4000-8000-000000000000',
          action: 'allow',
        })
      ).status,
    ).toBe(404);
    expect(
      (await action({ sessionId: session.id, requestId, action: 'always' }))
        .status,
    ).toBe(400);

    const allowed = await action({
      sessionId: session.id,
      requestId,
      action: 'allow',
    });
    expect(allowed.status).toBe(200);
    expect(allowed.json<ApprovalActionResult>()).toEqual({
      outcome: 'applied',
      decision: 'allow',
    });
    await expect(decision).resolves.toMatchObject({ behavior: 'allow' });
    // Allowed once, nothing for the rest of the session.
    const events = (
      await rawRequest(app.port, 'GET', `/api/sessions/${session.id}`)
    ).json<SessionDto>();
    expect(events.permissionMode).toBe('default');

    // A second tap (or a deny that arrives late) changes nothing.
    expect(
      (
        await action({ sessionId: session.id, requestId, action: 'deny' })
      ).json(),
    ).toEqual({ outcome: 'already_resolved', decision: 'allow' });

    // The notification is withdrawn on every channel.
    await service.settled();
    expect(push.payloads('withdraw')).toEqual([
      { type: 'withdraw', tags: [`approval-${requestId}`], badge: 0 },
    ]);
    expect(ntfy.requests.at(-1)).toMatchObject({
      method: 'DELETE',
      url: `https://ntfy.example.com/crm/${shortId(`approval-${requestId}`)}`,
    });
  });

  it('withdraws an approval answered in the app', async () => {
    await device();
    const session = await createSession();
    const { decision } = await requestApproval({ command: 'ls' });
    const [shown] = push.payloads('show');
    const requestId = shown.type === 'show' ? (shown.requestId as string) : '';
    await postJson(
      app.port,
      `/api/sessions/${session.id}/permission-requests/${requestId}`,
      { decision: 'deny', message: 'Not now' },
    );
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
    await service.settled();
    expect(push.payloads('withdraw')[0].tags).toEqual([
      `approval-${requestId}`,
    ]);
  });

  it('offers no Allow for a push of more than the session branch', async () => {
    await device();
    const session = await createSession();
    const { decision } = await requestApproval({
      command: 'git push --force origin HEAD:main',
    });
    const [shown] = push.payloads('show');
    expect(shown).toMatchObject({ title: 'Approve? Push', actions: ['deny'] });
    const requestId = shown.type === 'show' ? (shown.requestId as string) : '';
    expect(
      (
        await postJson(app.port, '/api/notifications/approval-actions', {
          sessionId: session.id,
          requestId,
          action: 'allow',
        })
      ).json(),
    ).toEqual({ outcome: 'not_offered', decision: null });
    // Still pending: decided in the session.
    expect(
      (
        await rawRequest(
          app.port,
          'GET',
          `/api/sessions/${session.id}/permission-requests`,
        )
      ).json<{ requests: unknown[] }>().requests,
    ).toHaveLength(1);
    await postJson(app.port, '/api/notifications/approval-actions', {
      sessionId: session.id,
      requestId,
      action: 'deny',
    });
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('notifies when a turn finished, not after Stop, and withdraws it on the next turn', async () => {
    await device();
    const session = await createSession();
    await finishTurn('The login works again.');
    expect(push.payloads('show')).toMatchObject([
      {
        tag: `turn-${session.id}`,
        title: 'Finished: Fix the login',
        body: 'The login works again.\nFix the login · scratch',
        actions: [],
        // Waiting for the next message is not blocked on the user.
        badge: 0,
      },
    ]);
    expect(ntfy.messages.at(-1)).toMatchObject({ priority: 3 });

    // The next message starts a turn: the notification is not current.
    await postJson(app.port, `/api/sessions/${session.id}/messages`, {
      text: 'And the logout?',
    });
    await flush();
    await service.settled();
    expect(push.payloads('withdraw').map((p) => p.tags)).toEqual([
      [`turn-${session.id}`],
    ]);

    // Stopped by the user: no notification.
    await postJson(app.port, `/api/sessions/${session.id}/interrupt`, {});
    await finishTurn('Stopped', {
      subtype: 'error_during_execution',
      is_error: true,
      errors: [],
    });
    expect(push.payloads('show')).toHaveLength(1);
  });

  it('reports a turn the usage limit stopped, with when it continues', async () => {
    await device();
    const session = await createSession();
    app.runner.last.emit(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'five_hour',
          resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600,
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'rate_limit',
        message: {
          id: 'm-limit',
          content: [{ type: 'text', text: "You've hit your 5-hour limit" }],
        },
      },
      resultMessage(1, 0, {
        is_error: true,
        result: "You've hit your 5-hour limit",
      }),
    );
    await flush();
    await flush();
    await service.settled();
    expect(push.payloads('show')).toMatchObject([
      {
        tag: `turn-${session.id}`,
        title: 'Usage limit: Fix the login',
        body: expect.stringMatching(
          /continues by itself once the limit has reset \(in about 2 h( 1 min)?\)\./,
        ),
      },
    ]);
  });

  it('says nothing about a limit when the session continues with another account', async () => {
    await device();
    const accounts = app.app.get(AccountsService);
    app.claudeCli.statuses.set(join(app.dir, 'claude'), {
      loggedIn: true,
      email: null,
      organization: null,
      subscriptionType: 'max',
      loginExpiresAt: null,
    });
    await accounts.refresh('main');
    const work = await accounts.create({ name: 'Work' });
    app.claudeCli.statuses.set(app.claudeCli.logins[0].account.configDir, {
      loggedIn: true,
      email: null,
      organization: null,
      subscriptionType: 'max',
      loginExpiresAt: null,
    });
    await accounts.refresh(work.id);
    app.runner.probeUsage = () =>
      ({
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 5, resets_at: null },
          seven_day: null,
          seven_day_opus: null,
          seven_day_sonnet: null,
          seven_day_oauth_apps: null,
        },
      }) as never;
    await createSession();
    app.runner.last.emit(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'five_hour',
          resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600,
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'rate_limit',
        message: {
          id: 'm-limit',
          content: [{ type: 'text', text: "You've hit your 5-hour limit" }],
        },
      },
      resultMessage(1, 0, {
        is_error: true,
        result: "You've hit your 5-hour limit",
      }),
    );
    await waitFor(() => app.runner.runs.length === 2);
    await flush();
    await service.settled();
    expect(
      push
        .payloads('show')
        .filter((payload) =>
          String((payload as { title?: string }).title).startsWith(
            'Usage limit',
          ),
        ),
    ).toEqual([]);
  });

  it('notifies a finished turn only once background work is over', async () => {
    await device();
    const session = await createSession();
    const tasks = (...ids: string[]) => ({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: ids.map((id) => ({
        task_id: id,
        task_type: 'local_agent',
        description: id,
      })),
    });
    app.runner.last.emit(tasks('agent'));
    await finishTurn('Started a subagent.');
    expect(push.payloads('show')).toEqual([]);

    // The subagent reported back: Claude goes on with a turn of its own.
    app.runner.last.emit(tasks());
    await flush();
    await service.settled();
    expect(push.payloads('show')).toEqual([]);
    await finishTurn('The subagent found it.');
    expect(push.payloads('show')).toMatchObject([
      { tag: `turn-${session.id}`, body: expect.stringContaining('found it') },
    ]);
  });

  it('reports a turn finished once, not again after waiting without a turn', async () => {
    await device();
    const session = await createSession();
    app.app.get(SessionsService).backgroundReportGraceMs = 5;
    await finishTurn('Opened the pull request.');
    expect(push.payloads('show')).toHaveLength(1);

    // Waiting again without a turn of its own (such as CI of a pull request
    // someone else pushed to) and Ready again: nothing new to report.
    const tasks = (...ids: string[]) => ({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: ids.map((id) => ({
        task_id: id,
        task_type: 'local_bash',
        description: id,
      })),
    });
    app.runner.last.emit(tasks('watch'));
    await flush();
    await waitFor(
      () =>
        app.app.get(SessionsService).get(session.id).waitingFor ===
        'background',
    );
    app.runner.last.emit(tasks());
    await waitFor(
      () =>
        app.app.get(SessionsService).get(session.id).waitingFor === 'message',
    );
    await flush();
    await service.settled();
    expect(push.payloads('show')).toHaveLength(1);
    // ...and the report of the finished turn stays.
    expect(push.payloads('withdraw')).toEqual([]);

    // Background again, then the next turn starts: now it is withdrawn.
    app.runner.last.emit(tasks('watch'));
    await waitFor(
      () =>
        app.app.get(SessionsService).get(session.id).waitingFor ===
        'background',
    );
    await postJson(app.port, `/api/sessions/${session.id}/messages`, {
      text: 'Next',
    });
    await flush();
    await service.settled();
    expect(push.payloads('withdraw').map((p) => p.tags)).toEqual([
      [`turn-${session.id}`],
    ]);
  });

  it('skips sessions an active client shows', async () => {
    await device();
    const session = await createSession();
    const client = new WebSocket(`ws://${app.host}${SESSIONS_WS_PATH}`);
    await new Promise((resolve) => client.once('open', resolve));
    const presence = (active: boolean) =>
      new Promise<void>((resolve) => {
        client.send(
          JSON.stringify({
            type: 'presence',
            sessionId: session.id,
            active,
            requestId: `p-${active}`,
          }),
        );
        client.on('message', (data) => {
          if (data.toString().includes(`"p-${active}"`)) {
            resolve();
          }
        });
      });
    await presence(true);
    await finishTurn('Done while watched');
    expect(push.payloads('show')).toEqual([]);
    expect(ntfy.messages).toEqual([]);

    // Hidden (e.g. the phone was put away): notified again.
    await presence(false);
    await postJson(app.port, `/api/sessions/${session.id}/messages`, {
      text: 'Next',
    });
    await flush();
    await finishTurn('Done while away');
    expect(push.payloads('show')).toHaveLength(1);
    client.close();
  });

  it('reports a stall once, withdraws it on activity and reports a new stall', async () => {
    await device();
    let now = Date.now();
    notifier.now = () => now;
    const session = await createSession();
    now += STALL_MS - 1000;
    notifier.checkStalls();
    expect(push.payloads('show')).toEqual([]);
    now += 2000;
    notifier.checkStalls();
    notifier.checkStalls();
    await service.settled();
    expect(push.payloads('show')).toMatchObject([
      {
        tag: `stall-${session.id}`,
        title: 'No activity: Fix the login',
        body: 'Running without any activity for 10 minutes.\nFix the login · scratch',
      },
    ]);
    // Activity: the stall notification is withdrawn.
    app.runner.last.emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'm1', content: [{ type: 'text', text: 'Still here' }] },
    });
    await flush();
    await service.settled();
    expect(push.payloads('withdraw')).toEqual([
      { type: 'withdraw', tags: [`stall-${session.id}`], badge: 0 },
    ]);
    now += STALL_MS;
    notifier.checkStalls();
    await service.settled();
    expect(push.payloads('show')).toHaveLength(2);
  });

  it('notifies about failed sessions', async () => {
    await device();
    const session = await createSession();
    app.runner.last.crash(new Error('Claude Code crashed'));
    await waitFor(() => push.payloads('show').length > 0);
    expect(push.payloads('show')[0]).toMatchObject({
      tag: `failed-${session.id}`,
      title: 'Failed: Fix the login',
    });
    expect(push.payloads('show')[0].body).toContain('Claude Code crashed');
  });

  it('respects the preferences', async () => {
    await device();
    await rawRequest(
      app.port,
      'PUT',
      '/api/notifications/preferences',
      { 'content-type': 'application/json' },
      JSON.stringify({ preferences: { turn_finished: { webPush: false } } }),
    );
    await createSession();
    await finishTurn('Done');
    expect(push.payloads('show')).toEqual([]);
    expect(ntfy.messages).toHaveLength(1);
  });

  it('lets the PR automation report its events', async () => {
    await device();
    const session = await createSession();
    const pullRequest = {
      id: 7,
      repositoryId: 'r',
      repository: 'acme/app',
      number: 12,
      url: 'https://github.com/acme/app/pull/12',
      title: 'Fix login',
      state: 'merged' as const,
      draft: false,
      headBranch: 'claude/x',
      baseBranch: 'main',
      createdBy: 'claude' as const,
      openedAt: '',
      closedAt: null,
      mergedAt: '',
      syncedAt: '',
      automation: {
        autofix: true,
        autoclose: true,
        automerge: {
          enabled: false,
          held: null,
          failure: null,
          waiting: null,
        },
        running: false,
        lastRunAt: null,
        lastTrigger: null,
      },
    };
    expect(service.notifyPullRequestClosed(session.id, pullRequest)).toBe(true);
    await service.settled();
    expect(push.payloads('show').map((p) => [p.tag, p.title])).toEqual([
      ['pr-7', 'Merged: acme/app#12'],
    ]);
  });
});
