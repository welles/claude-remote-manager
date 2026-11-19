import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKey, SecretCipher } from './secret-cipher';

describe('SecretCipher', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crm-cipher-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates a private key file on first use and round-trips', () => {
    const file = join(dir, 'db', 'environment.key');
    const cipher = new SecretCipher(file, undefined);
    const stored = cipher.encrypt('sk-very-secret', 'entry-1');
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain('sk-very-secret');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Another instance reads the same key.
    expect(new SecretCipher(file, undefined).decrypt(stored, 'entry-1')).toBe(
      'sk-very-secret',
    );
    expect(parseKey(readFileSync(file, 'utf8'))).toHaveLength(32);
  });

  it('binds a value to its entry', () => {
    const cipher = new SecretCipher(join(dir, 'k'), undefined);
    const stored = cipher.encrypt('value', 'entry-1');
    expect(() => cipher.decrypt(stored, 'entry-2')).toThrow();
  });

  it('prefers the key from the variable (hex or Base64)', () => {
    const hex = 'ab'.repeat(32);
    const cipher = new SecretCipher(join(dir, 'unused'), hex);
    const stored = cipher.encrypt('x', 'e');
    const base64 = Buffer.from(hex, 'hex').toString('base64');
    expect(
      new SecretCipher(join(dir, 'other'), base64).decrypt(stored, 'e'),
    ).toBe('x');
    expect(() => statSync(join(dir, 'unused'))).toThrow();
    expect(() =>
      new SecretCipher(join(dir, 'k'), 'short').encrypt('x', 'e'),
    ).toThrow('32 bytes');
  });
});
