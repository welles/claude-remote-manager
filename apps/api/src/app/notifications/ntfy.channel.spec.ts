import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { testAppConfig, type NtfyConfig } from '../config/app-config';
import { shortId, type AppNotification } from './notification';
import { NtfyChannel } from './ntfy.channel';
import { FakeNtfy } from './testing/fakes';

const TOKEN = 'tk_0123456789abcdefghijklmnopqr';

const notification: AppNotification = {
  type: 'approval',
  key: 'approval-1',
  sessionId: 's1',
  title: 'Approve? Run a command',
  body: 'npm test\nFix login · acme/app',
  path: '/sessions/s1',
  requestId: 'r1',
  actions: ['allow', 'deny'],
  urgent: true,
  at: 0,
};

describe('NtfyChannel', () => {
  let dir: string;
  let ntfy: FakeNtfy;
  let tokenFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crm-ntfy-'));
    tokenFile = join(dir, 'token');
    writeFileSync(tokenFile, `${TOKEN}\n`);
    ntfy = new FakeNtfy();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const channel = (
    config: Partial<NtfyConfig> | null = {},
    publicUrl: string | null = 'https://crm.example.com',
  ) =>
    new NtfyChannel(
      testAppConfig(dir, {
        notifications: {
          publicUrl,
          stallMs: 0,
          ntfy:
            config === null
              ? null
              : {
                  server: 'https://ntfy.example.com',
                  topic: 'crm',
                  tokenFile,
                  ...config,
                },
          vapid: { publicKey: null, privateKeyFile: null, subject: null },
        },
      }),
      ntfy.fetch,
    );

  it('publishes with the token as Bearer header, details and a link', async () => {
    await channel().show(notification);
    expect(ntfy.requests).toEqual([
      {
        url: 'https://ntfy.example.com/',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: {
          topic: 'crm',
          title: 'Approve? Run a command',
          message: 'npm test\nFix login · acme/app',
          priority: 4,
          tags: ['raising_hand'],
          click: 'https://crm.example.com/sessions/s1',
          sequence_id: shortId('approval-1'),
        },
      },
    ]);
  });

  it('has no link without a public URL', async () => {
    await channel({}, null).show(notification);
    expect(ntfy.messages[0]).not.toHaveProperty('click');
  });

  it('deletes withdrawn messages by their sequence ID', async () => {
    await channel().withdraw(['approval-1']);
    expect(ntfy.requests).toEqual([
      {
        url: `https://ntfy.example.com/crm/${shortId('approval-1')}`,
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: null,
      },
    ]);
  });

  it('reports a refused token in the test without showing it', async () => {
    ntfy.respond = () =>
      new Response(
        JSON.stringify({
          code: 40101,
          http: 401,
          error: `unauthorized ${TOKEN}`,
        }),
        { status: 401 },
      );
    const result = await channel().test();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('HTTP 401: unauthorized');
    expect(result.message).toContain('check the access token');
    expect(result.message).not.toContain(TOKEN);
  });

  it('reports a server it cannot reach', async () => {
    ntfy.respond = () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      });
    };
    expect(await channel().test()).toEqual({
      ok: false,
      message: 'ntfy did not accept it: not reachable (ECONNREFUSED)',
    });
  });

  it('succeeds in the test and names topic and server', async () => {
    expect(await channel().test()).toEqual({
      ok: true,
      message: 'Sent to topic crm on https://ntfy.example.com.',
    });
    expect(ntfy.messages[0]).toMatchObject({
      topic: 'crm',
      title: 'Test notification',
      click: 'https://crm.example.com/settings',
    });
  });

  it('stays off without configuration or without a readable token', async () => {
    const off = channel(null);
    expect(off.available).toBe(false);
    expect((await off.test()).ok).toBe(false);
    const unreadable = channel({ tokenFile: join(dir, 'missing') });
    expect(unreadable.available).toBe(false);
    expect(unreadable.tokenSet).toBe(false);
    expect(unreadable.problem).toContain('could not be read (ENOENT)');
    await unreadable.show(notification);
    expect(ntfy.requests).toEqual([]);
  });

  it('never shows the token when inspected or serialized', () => {
    const ready = channel();
    expect(ready.tokenSet).toBe(true);
    expect(JSON.stringify(ready)).not.toContain(TOKEN);
    expect(inspect(ready, { depth: 5 })).not.toContain(TOKEN);
  });
});
