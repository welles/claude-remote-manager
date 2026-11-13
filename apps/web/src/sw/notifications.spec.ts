import type { PushPayload } from '@claude-remote-manager/shared-types';
import {
  afterAction,
  notificationFor,
  parsePayload,
  safePath,
  sendApprovalAction,
  type NotificationData,
} from './notifications';

const show: Extract<PushPayload, { type: 'show' }> = {
  type: 'show',
  tag: 'approval-r1',
  title: 'Approve? Run a command',
  body: 'npm test\nFix login · acme/app',
  url: '/sessions/s1',
  sessionId: 's1',
  requestId: 'r1',
  actions: ['allow', 'deny'],
  renotify: true,
  badge: 2,
  timestamp: 1000,
};

const data: NotificationData = {
  url: '/sessions/s1',
  sessionId: 's1',
  requestId: 'r1',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('service worker notifications', () => {
  it('accepts only the app’s push messages', () => {
    expect(parsePayload(JSON.stringify(show))).toEqual(show);
    expect(
      parsePayload('{"type":"withdraw","tags":["a"],"badge":null}'),
    ).toEqual({ type: 'withdraw', tags: ['a'], badge: null });
    expect(parsePayload('{"type":"other"}')).toBeNull();
    expect(parsePayload('not json')).toBeNull();
    expect(parsePayload(null)).toBeNull();
  });

  it('shows approvals with Allow once and Deny, kept until answered', () => {
    const { title, options } = notificationFor(show);
    expect(title).toBe('Approve? Run a command');
    expect(options).toMatchObject({
      body: 'npm test\nFix login · acme/app',
      tag: 'approval-r1',
      renotify: true,
      requireInteraction: true,
      data,
      actions: [
        { action: 'allow', title: 'Allow once' },
        { action: 'deny', title: 'Deny' },
      ],
    });
    // Without a request there is nothing to answer.
    const finished = notificationFor({
      ...show,
      tag: 'turn-s1',
      requestId: null,
      actions: ['allow'],
    }).options;
    expect(finished.actions).toEqual([]);
    expect(finished.requireInteraction).toBe(false);
  });

  it('opens only paths of the app', () => {
    expect(safePath('/sessions/s1')).toBe('/sessions/s1');
    expect(safePath('//evil.example/x')).toBe('/');
    expect(safePath('https://evil.example/')).toBe('/');
    expect(safePath('/\\evil.example')).toBe('/');
  });

  it('answers with an ordinary request of the app, without any token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const outcome = await sendApprovalAction(
      async (url, init) => {
        calls.push({ url, init });
        return json({ outcome: 'applied', decision: 'allow' });
      },
      data,
      'allow',
    );
    expect(outcome).toEqual({
      kind: 'done',
      result: { outcome: 'applied', decision: 'allow' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/notifications/approval-actions');
    expect(calls[0].init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      redirect: 'manual',
    });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      sessionId: 's1',
      requestId: 'r1',
      action: 'allow',
    });
  });

  it.each([
    [
      'a redirect to the Access login',
      async () =>
        Object.defineProperty(new Response(null, { status: 200 }), 'type', {
          value: 'opaqueredirect',
        }) as Response,
      'signed_out',
    ],
    [
      'a 401',
      async () => json({ reason: 'access_token_expired' }, 401),
      'signed_out',
    ],
    ['a 403', async () => json({}, 403), 'signed_out'],
    [
      'a login page',
      async () => new Response('<html>Sign in</html>'),
      'signed_out',
    ],
    ['a server error', async () => json({}, 500), 'refused'],
    [
      'no connection',
      async () => {
        throw new TypeError('Failed to fetch');
      },
      'offline',
    ],
  ])('reports %s as not answered', async (_, respond, failure) => {
    const outcome = await sendApprovalAction(respond, data, 'allow');
    expect(outcome).toEqual({ kind: 'failed', failure });
    // The user is led into the session, where the request still waits.
    expect(afterAction(outcome, 'allow')).toEqual({
      notice: {
        title: 'Not allowed: still waiting',
        body: expect.stringContaining(
          'Open the session to answer the request.',
        ),
      },
      open: true,
    });
  });

  it('says when the request had been answered before', () => {
    expect(
      afterAction(
        {
          kind: 'done',
          result: { outcome: 'already_resolved', decision: 'allow' },
        },
        'deny',
      ),
    ).toEqual({
      notice: {
        title: 'Already answered',
        body: 'This request had been allowed before; your answer was not used.',
      },
      open: false,
    });
    expect(
      afterAction(
        { kind: 'done', result: { outcome: 'applied', decision: 'deny' } },
        'deny',
      ),
    ).toEqual({ notice: null, open: false });
    expect(
      afterAction(
        { kind: 'done', result: { outcome: 'not_offered', decision: null } },
        'allow',
      ).open,
    ).toBe(true);
  });
});
