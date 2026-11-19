import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawRequest, startTestApp, type TestApp } from '../testing/test-app';
import { WEBHOOK_SECRET_VARIABLE } from '../config/app-config';
import { WebhookHandler, WEBHOOK_MAX_BODY_BYTES } from './webhook.controller';
import { signWebhookBody, WebhookSecret } from './webhook-signature';

const SECRET = 'a-webhook-secret-of-some-length';

describe('WebhookSecret', () => {
  const secret = WebhookSecret.of(SECRET);
  const body = Buffer.from('{"action":"completed"}');

  it('accepts the signature of exactly this body', () => {
    expect(secret.verify(body, signWebhookBody(SECRET, body))).toBe('ok');
    // Hex digits in upper case are the same signature.
    expect(
      secret.verify(
        body,
        signWebhookBody(SECRET, body)
          .toUpperCase()
          .replace('SHA256=', 'sha256='),
      ),
    ).toBe('ok');
  });

  it('refuses missing, malformed and wrong signatures', () => {
    const valid = signWebhookBody(SECRET, body);
    expect(secret.verify(body, undefined)).toBe('missing');
    expect(secret.verify(body, '')).toBe('missing');
    expect(secret.verify(body, valid.slice('sha256='.length))).toBe(
      'malformed',
    );
    expect(secret.verify(body, valid.replace('sha256=', 'sha1='))).toBe(
      'malformed',
    );
    expect(secret.verify(body, `${valid}00`)).toBe('malformed');
    expect(secret.verify(body, valid.slice(0, -2))).toBe('malformed');
    expect(secret.verify(body, `sha256=${'z'.repeat(64)}`)).toBe('malformed');
    expect(secret.verify(body, [valid, valid])).toBe('malformed');
    expect(
      secret.verify(body, signWebhookBody('another-secret-value', body)),
    ).toBe('mismatch');
    // One byte of the body differs.
    const changed = Buffer.from(body);
    changed[changed.length - 2] ^= 1;
    expect(secret.verify(changed, valid)).toBe('mismatch');
    expect(secret.verify(Buffer.concat([body, Buffer.from(' ')]), valid)).toBe(
      'mismatch',
    );
  });

  it('refuses everything without a secret', () => {
    const none = WebhookSecret.of(null);
    expect(none.configured).toBe(false);
    expect(none.verify(body, signWebhookBody(SECRET, body))).toBe(
      'not_configured',
    );
  });

  it('loads the secret from a file or the secret variable, and refuses unusable ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crm-webhook-'));
    try {
      expect(WebhookSecret.load(null, {}).configured).toBe(false);
      expect(
        WebhookSecret.load(null, { [WEBHOOK_SECRET_VARIABLE]: SECRET })
          .configured,
      ).toBe(true);
      const file = join(dir, 'secret');
      writeFileSync(file, `${SECRET}\n`);
      const loaded = WebhookSecret.load(file, {});
      expect(loaded.verify(body, signWebhookBody(SECRET, body))).toBe('ok');
      expect(() => WebhookSecret.load(join(dir, 'missing'), {})).toThrow(
        'could not be read',
      );
      writeFileSync(file, 'tooshort');
      expect(() => WebhookSecret.load(file, {})).toThrow('at least 16');
      // Errors name the file, never the content.
      expect(() => WebhookSecret.load(file, {})).not.toThrow('tooshort');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/github/webhook', () => {
  let app: TestApp;
  let received: { event: string; payload: unknown }[];
  let dir: string;

  const start = async (secret: string | null) => {
    dir = mkdtempSync(join(tmpdir(), 'crm-webhook-app-'));
    let file: string | null = null;
    if (secret !== null) {
      file = join(dir, 'webhook-secret');
      writeFileSync(file, secret);
    }
    received = [];
    app = await startTestApp(
      {
        // A public host behind the tunnel; the webhook does not need it.
        allowedHosts: ['crm.example.com'],
        prAutomation: {
          webhookSecretFile: file,
          pollIntervalMs: 0,
          trustedBots: [],
        },
      },
      {
        configure: (builder) =>
          builder.overrideProvider(WebhookHandler).useValue({
            onWebhook: (event: string, payload: unknown) =>
              received.push({ event, payload }),
          }),
      },
    );
  };
  afterEach(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const deliver = (
    body: string | Buffer,
    headers: Record<string, string> = {},
    signature: string | null = signWebhookBody(SECRET, body),
  ) =>
    rawRequest(
      app.port,
      'POST',
      '/api/github/webhook',
      {
        'content-type': 'application/json',
        'x-github-event': 'check_suite',
        'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
        ...(signature === null ? {} : { 'x-hub-signature-256': signature }),
        ...headers,
      },
      body as string,
    );

  const payload = JSON.stringify({
    action: 'completed',
    repository: { id: 1 },
    check_suite: { pull_requests: [{ number: 5 }] },
  });

  it('refuses every delivery without a configured secret', async () => {
    await start(null);
    const response = await deliver(payload);
    expect(response.status).toBe(503);
    expect(received).toHaveLength(0);
  });

  it('accepts a correctly signed delivery once', async () => {
    await start(SECRET);
    const response = await deliver(payload);
    expect(response.status).toBe(202);
    expect(received).toEqual([
      { event: 'check_suite', payload: JSON.parse(payload) },
    ]);
    // A redelivery (same delivery ID) changes nothing.
    const again = await deliver(payload);
    expect(again.status).toBe(200);
    expect(received).toHaveLength(1);
    // Another delivery of the same event is processed (it is only a signal).
    expect(
      (await deliver(payload, { 'x-github-delivery': 'other-delivery-1' }))
        .status,
    ).toBe(202);
    expect(received).toHaveLength(2);
  });

  it('refuses missing, malformed and wrong signatures and changed bodies', async () => {
    await start(SECRET);
    expect((await deliver(payload, {}, null)).status).toBe(401);
    expect((await deliver(payload, {}, 'sha256=abc')).status).toBe(401);
    expect(
      (
        await deliver(
          payload,
          {},
          signWebhookBody('wrong-secret-0000', payload),
        )
      ).status,
    ).toBe(401);
    const changed = payload.replace('"number":5', '"number":6');
    expect(changed.length).toBe(payload.length);
    expect(
      (await deliver(changed, {}, signWebhookBody(SECRET, payload))).status,
    ).toBe(401);
    expect(received).toHaveLength(0);
  });

  it('needs no Access token or browser headers, only the signature', async () => {
    await start(SECRET);
    // Not the app's origin and cross-site: the request guard would refuse
    // this for every other route.
    const response = await deliver(payload, {
      host: 'crm.example.com',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
      'x-github-delivery': 'cross-site-1',
    });
    expect(response.status).toBe(202);
    const unsigned = await deliver(
      payload,
      { origin: 'https://evil.example', 'x-github-delivery': 'cross-site-2' },
      null,
    );
    expect(unsigned.status).toBe(401);
  });

  it('takes JSON only, bounded in size', async () => {
    await start(SECRET);
    const form = 'payload=%7B%7D';
    expect(
      (
        await deliver(form, {
          'content-type': 'application/x-www-form-urlencoded',
        })
      ).status,
    ).toBe(415);
    const large = JSON.stringify({ text: 'x'.repeat(WEBHOOK_MAX_BODY_BYTES) });
    expect((await deliver(large)).status).toBe(413);
    const notJson = '{"unterminated": ';
    expect(
      (await deliver(notJson, { 'x-github-delivery': 'broken-json' })).status,
    ).toBe(400);
    expect(received).toHaveLength(0);
  });

  it('ignores events the automation does not use and answers pings', async () => {
    await start(SECRET);
    const push = await deliver(payload, {
      'x-github-event': 'push',
      'x-github-delivery': 'push-1',
    });
    expect(push.status).toBe(202);
    const ping = await deliver('{"zen":"Keep it simple."}', {
      'x-github-event': 'ping',
      'x-github-delivery': 'ping-1',
    });
    expect(ping.status).toBe(200);
    expect(received).toHaveLength(0);
    expect(
      (await deliver(payload, { 'x-github-event': 'Not An Event!' })).status,
    ).toBe(400);
  });
});
