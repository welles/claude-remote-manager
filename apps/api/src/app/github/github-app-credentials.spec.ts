import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { createVerify } from 'node:crypto';
import {
  GitHubAppCredentials,
  PRIVATE_KEY_VARIABLE,
} from './github-app-credentials';
import { testKeyPair } from './testing/fake-github';

describe('GitHubAppCredentials', () => {
  const { privateKey, publicKey } = testKeyPair();
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  let dir: string;

  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'crm-key-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is not configured without an App ID', () => {
    const credentials = GitHubAppCredentials.load(null, {});
    expect(credentials.configured).toBe(false);
    expect(credentials.problem).toContain('GITHUB_APP_ID');
    expect(() => credentials.jwt()).toThrow('not configured');
  });

  it('reports a missing or unreadable key without failing', () => {
    expect(
      GitHubAppCredentials.load({ appId: '1', privateKeyFile: null }, {})
        .problem,
    ).toContain('no private key');
    const broken = join(dir, 'broken.pem');
    writeFileSync(broken, 'not a key');
    const credentials = GitHubAppCredentials.load(
      { appId: '1', privateKeyFile: broken },
      {},
    );
    expect(credentials.configured).toBe(false);
    expect(credentials.problem).toContain('could not be read');
    expect(credentials.problem).not.toContain('not a key');
  });

  it('reads the key from a file or the secret variable', () => {
    const file = join(dir, 'key.pem');
    writeFileSync(file, pem);
    expect(
      GitHubAppCredentials.load({ appId: '7', privateKeyFile: file }, {})
        .configured,
    ).toBe(true);
    expect(
      GitHubAppCredentials.load(
        { appId: '7', privateKeyFile: null },
        { [PRIVATE_KEY_VARIABLE]: pem },
      ).configured,
    ).toBe(true);
  });

  it('signs short-lived app JWTs and reuses them', () => {
    let now = 1_700_000_000_000;
    const credentials = GitHubAppCredentials.fromKey(
      '7',
      privateKey,
      () => now,
    );
    const jwt = credentials.jwt();
    const [header, payload, signature] = jwt.split('.');
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .verify(publicKey, Buffer.from(signature, 'base64url')),
    ).toBe(true);
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims).toEqual({
      iss: '7',
      iat: 1_700_000_000 - 60,
      exp: 1_700_000_000 + 540,
    });
    now += 5 * 60_000;
    expect(credentials.jwt()).toBe(jwt);
    now += 4 * 60_000;
    expect(credentials.jwt()).not.toBe(jwt);
  });

  it('never shows the key when logged or serialized', () => {
    const credentials = GitHubAppCredentials.load(
      { appId: '7', privateKeyFile: null },
      { [PRIVATE_KEY_VARIABLE]: pem },
    );
    const keyBody = pem.split('\n')[1];
    expect(JSON.stringify({ credentials })).not.toContain(keyBody);
    expect(inspect(credentials, { depth: 10 })).not.toContain(keyBody);
    expect(inspect(credentials, { depth: 10 })).not.toContain('PRIVATE');
  });
});
