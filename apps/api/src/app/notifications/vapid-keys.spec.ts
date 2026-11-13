import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as webPush from 'web-push';
import { loadVapidKeys, publicKeyOf, VAPID_KEY_FILE_NAME } from './vapid-keys';

const quiet = { log: () => undefined, warn: () => undefined };
const noVapid = { publicKey: null, privateKeyFile: null, subject: null };

describe('VAPID keys', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crm-vapid-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('are generated once into the data directory, readable by the API only', () => {
    const data = join(dir, 'db');
    const first = loadVapidKeys(noVapid, data, {}, quiet);
    expect(first.problem).toBeNull();
    const file = join(data, VAPID_KEY_FILE_NAME);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = loadVapidKeys(noVapid, data, {}, quiet);
    expect(again.keys).toEqual(first.keys);
    // A valid P-256 pair for the web-push library.
    const keys = first.keys;
    if (!keys) {
      throw new Error('no keys');
    }
    expect(publicKeyOf(keys.privateKey)).toBe(keys.publicKey);
    expect(Buffer.from(keys.publicKey, 'base64url')).toHaveLength(65);
    expect(() =>
      webPush.getVapidHeaders(
        'https://fcm.googleapis.com',
        'mailto:a@example.org',
        keys.publicKey,
        keys.privateKey,
        'aes128gcm',
      ),
    ).not.toThrow();
  });

  it('restricts a key file others could read', () => {
    const data = join(dir, 'db');
    loadVapidKeys(noVapid, data, {}, quiet);
    const file = join(data, VAPID_KEY_FILE_NAME);
    chmodSync(file, 0o644);
    const warnings: string[] = [];
    loadVapidKeys(
      noVapid,
      data,
      {},
      { ...quiet, warn: (m) => warnings.push(m) },
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(warnings).toHaveLength(1);
  });

  it('come from the environment when given, file or variable', () => {
    const pair = webPush.generateVAPIDKeys();
    const fromVariable = loadVapidKeys(
      noVapid,
      join(dir, 'db'),
      { CRM_SECRET_VAPID_PRIVATE_KEY: pair.privateKey },
      quiet,
    );
    expect(fromVariable.keys).toEqual(pair);
    const file = join(dir, 'vapid.key');
    writeFileSync(file, `${pair.privateKey}\n`);
    expect(
      loadVapidKeys(
        { ...noVapid, privateKeyFile: file, publicKey: pair.publicKey },
        join(dir, 'db'),
        {},
        quiet,
      ).keys,
    ).toEqual(pair);
    // Nothing was generated meanwhile.
    expect(() => statSync(join(dir, 'db', VAPID_KEY_FILE_NAME))).toThrow();
  });

  it('report wrong or missing keys without showing them', () => {
    const pair = webPush.generateVAPIDKeys();
    const other = webPush.generateVAPIDKeys();
    const mismatch = loadVapidKeys(
      { ...noVapid, publicKey: other.publicKey },
      ':memory:',
      { CRM_SECRET_VAPID_PRIVATE_KEY: pair.privateKey },
      quiet,
    );
    expect(mismatch).toEqual({
      keys: null,
      problem: 'VAPID_PUBLIC_KEY does not belong to the VAPID private key',
    });
    const missing = loadVapidKeys(
      { ...noVapid, privateKeyFile: join(dir, 'missing') },
      ':memory:',
      {},
      quiet,
    );
    expect(missing.keys).toBeNull();
    expect(missing.problem).toContain('could not be read (ENOENT)');
    const garbage = loadVapidKeys(
      noVapid,
      ':memory:',
      { CRM_SECRET_VAPID_PRIVATE_KEY: 'not-a-key' },
      quiet,
    );
    expect(garbage.problem).toBe(
      'The VAPID private key is not a base64url P-256 key',
    );
    expect(JSON.stringify([mismatch, missing, garbage])).not.toContain(
      pair.privateKey,
    );
  });
});
