import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

/** Parses a key given as Base64 or hex (32 bytes). */
export function parseKey(text: string): Buffer {
  const trimmed = text.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      'The key of the environments must be 32 bytes, as Base64 or hex',
    );
  }
  return key;
}

/**
 * Encrypts the secrets of environments with AES-256-GCM, bound to the
 * entry they belong to (its ID as additional data), so a value cannot be
 * moved to another entry in the database. The key comes from the secret
 * variable, else from the key file, which is created (`0600`) if missing.
 * Loaded on first use, so the app starts without it.
 */
export class SecretCipher {
  private key: Buffer | null = null;

  constructor(
    private readonly keyFile: string,
    private readonly keyText: string | undefined,
  ) {}

  encrypt(plain: string, entryId: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.loadKey(), iv, {
      authTagLength: TAG_BYTES,
    }) as CipherGCM;
    cipher.setAAD(Buffer.from(entryId, 'utf8'));
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), body]);
    return `${VERSION}:${payload.toString('base64')}`;
  }

  decrypt(stored: string, entryId: string): string {
    const [version, data] = stored.split(':', 2);
    if (version !== VERSION || !data) {
      throw new Error('Unknown format of an encrypted secret');
    }
    const payload = Buffer.from(data, 'base64');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.loadKey(),
      payload.subarray(0, IV_BYTES),
      { authTagLength: TAG_BYTES },
    ) as DecipherGCM;
    decipher.setAAD(Buffer.from(entryId, 'utf8'));
    decipher.setAuthTag(payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(payload.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  }

  private loadKey(): Buffer {
    if (this.key) {
      return this.key;
    }
    if (this.keyText?.trim()) {
      this.key = parseKey(this.keyText);
      return this.key;
    }
    try {
      this.key = parseKey(readFileSync(this.keyFile, 'utf8'));
      return this.key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    mkdirSync(dirname(this.keyFile), { recursive: true });
    try {
      // `wx`: never replaces a key another start just wrote.
      writeFileSync(
        this.keyFile,
        `${randomBytes(KEY_BYTES).toString('base64')}\n`,
        {
          mode: 0o600,
          flag: 'wx',
        },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    this.key = parseKey(readFileSync(this.keyFile, 'utf8'));
    return this.key;
  }
}
