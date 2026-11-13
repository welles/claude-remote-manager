import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { testAppConfig } from '../config/app-config';
import { openDatabase, type AppDatabase } from '../db/database';
import { shortId, type AppNotification } from './notification';
import { PushSubscriptionRepository } from './push-subscription.repository';
import { RecordingPushSender } from './testing/fakes';
import { WebPushChannel } from './web-push.channel';

const KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString(
  'base64url',
);

const notification: AppNotification = {
  type: 'approval',
  key: 'approval-1',
  sessionId: 's1',
  title: 'Approve? Run a command',
  body: 'npm test',
  path: '/sessions/s1',
  requestId: 'r1',
  actions: ['allow', 'deny'],
  urgent: true,
  at: 1000,
};

describe('WebPushChannel', () => {
  let dir: string;
  let db: AppDatabase;
  let subscriptions: PushSubscriptionRepository;
  let sender: RecordingPushSender;
  let channel: WebPushChannel;

  const add = (endpoint: string) =>
    subscriptions.upsert({
      endpoint,
      p256dh: KEY,
      auth: 'YXV0aA',
      label: 'Chrome on Android',
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crm-push-'));
    db = openDatabase(':memory:');
    subscriptions = new PushSubscriptionRepository(db);
    sender = new RecordingPushSender();
    channel = new WebPushChannel(
      testAppConfig(dir, {
        notifications: {
          publicUrl: 'https://crm.example.com',
          stallMs: 0,
          ntfy: null,
          vapid: { publicKey: null, privateKeyFile: null, subject: null },
        },
      }),
      subscriptions,
      sender,
    );
  });
  afterEach(() => {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('shows a notification on every device, replaceable by its topic', async () => {
    add('https://fcm.googleapis.com/fcm/send/a');
    add('https://updates.push.services.mozilla.com/wpush/v2/b');
    await channel.show(notification, 2);
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[0]).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/a',
      payload: {
        type: 'show',
        tag: 'approval-1',
        title: 'Approve? Run a command',
        body: 'npm test',
        url: '/sessions/s1',
        sessionId: 's1',
        requestId: 'r1',
        actions: ['allow', 'deny'],
        renotify: true,
        badge: 2,
        timestamp: 1000,
      },
      options: { ttl: 86400, urgency: 'high', topic: shortId('approval-1') },
      // The public URL identifies the sender to the push services.
      subject: 'https://crm.example.com',
    });
    expect(subscriptions.list().every((row) => row.lastSuccessAt)).toBe(true);
  });

  it('withdraws with the same topic, except on Apple devices', async () => {
    add('https://fcm.googleapis.com/fcm/send/a');
    add('https://web.push.apple.com/QGx');
    await channel.withdraw(['approval-1'], 0);
    expect(sender.sent).toEqual([
      {
        endpoint: 'https://fcm.googleapis.com/fcm/send/a',
        payload: { type: 'withdraw', tags: ['approval-1'], badge: 0 },
        options: {
          ttl: 86400,
          urgency: 'normal',
          topic: shortId('approval-1'),
        },
        subject: 'https://crm.example.com',
      },
    ]);
  });

  it('removes subscriptions the push service reports gone', async () => {
    add('https://fcm.googleapis.com/fcm/send/gone');
    add('https://fcm.googleapis.com/fcm/send/broken');
    add('https://fcm.googleapis.com/fcm/send/ok');
    sender.status.set('https://fcm.googleapis.com/fcm/send/gone', 410);
    sender.status.set('https://fcm.googleapis.com/fcm/send/broken', 500);
    const result = await channel.test();
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      'Sent to 1 of 3 devices; Chrome on Android: subscription gone, removed; Chrome on Android: the push service answered 500.',
    );
    expect(
      subscriptions.list().map((row) => [row.endpoint, row.lastError]),
    ).toEqual([
      [
        'https://fcm.googleapis.com/fcm/send/broken',
        'the push service answered 500',
      ],
      ['https://fcm.googleapis.com/fcm/send/ok', null],
    ]);
  });

  it('says when no device is subscribed', async () => {
    expect(await channel.test()).toEqual({
      ok: false,
      message:
        'No device is subscribed. Enable notifications on this device first.',
    });
  });

  it('never shows the private key', () => {
    expect(channel.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(inspect(channel, { depth: 5 })).not.toContain('privateKey');
  });
});
