import { createECDH } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import {
  VAPID_PRIVATE_KEY_VARIABLE,
  type VapidConfig,
} from '../config/app-config';
import { readSecret } from './secrets';

/** Generated keys live in the API's data directory, readable by it only. */
export const VAPID_KEY_FILE_NAME = 'vapid-keys.json';

/** Contact sent with VAPID when neither `VAPID_SUBJECT` nor an https `PUBLIC_URL` is set. */
export const DEFAULT_VAPID_SUBJECT =
  'mailto:notifications@claude-remote-manager.invalid';

export interface VapidKeyPair {
  /** Uncompressed P-256 public key, base64url (`applicationServerKey`). */
  publicKey: string;
  /** P-256 private key, base64url. Never leaves the API. */
  privateKey: string;
}

/**
 * A P-256 private key as the 32 bytes VAPID needs. Node's
 * `ECDH.getPrivateKey()` drops leading zero bytes, so about one key in 256
 * comes out shorter; the web-push library (and the push services) want the
 * fixed-width scalar.
 */
export function fixedWidthPrivateKey(key: Buffer): Buffer {
  return key.length < 32
    ? Buffer.concat([Buffer.alloc(32 - key.length), key])
    : key;
}

/** The public key of a P-256 private key, base64url. */
export function publicKeyOf(privateKey: string): string {
  const key = Buffer.from(privateKey, 'base64url');
  if (
    !/^[A-Za-z0-9_-]+$/.test(privateKey) ||
    // Node writes keys with leading zero bytes left out (see
    // fixedWidthPrivateKey); more than three missing is not a key.
    key.length < 29 ||
    key.length > 32
  ) {
    throw new Error('not a P-256 private key');
  }
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(fixedWidthPrivateKey(key));
  return ecdh.getPublicKey().toString('base64url');
}

/** A private key in its 32-byte form (keys stored shorter by earlier versions). */
function normalizedPrivateKey(privateKey: string): string {
  return fixedWidthPrivateKey(Buffer.from(privateKey, 'base64url')).toString(
    'base64url',
  );
}

function generate(): VapidKeyPair {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: fixedWidthPrivateKey(ecdh.getPrivateKey()).toString(
      'base64url',
    ),
  };
}

/**
 * The VAPID keys that identify this server to the push services:
 *
 * - from the environment when `VAPID_PRIVATE_KEY_FILE` or
 *   `CRM_SECRET_VAPID_PRIVATE_KEY` is set (`VAPID_PUBLIC_KEY` optional; it
 *   must belong to the private key);
 * - otherwise generated on the first start and kept in
 *   `<dataDir>/vapid-keys.json` (mode 0600, inside the API's 0700 data
 *   directory), so subscriptions stay valid across restarts. Without a data
 *   directory (tests: `:memory:`) they live in memory only.
 *
 * Changing the keys invalidates all subscriptions: the devices have to
 * enable notifications again. Never throws: a problem is reported and Web
 * Push stays off.
 */
export function loadVapidKeys(
  config: VapidConfig,
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
  logger: Pick<Logger, 'log' | 'warn'> = new Logger('WebPush'),
): { keys: VapidKeyPair | null; problem: string | null } {
  const fromEnvironment =
    config.privateKeyFile !== null ||
    Boolean(env[VAPID_PRIVATE_KEY_VARIABLE]?.trim()) ||
    config.publicKey !== null;
  if (fromEnvironment) {
    const secret = readSecret(
      config.privateKeyFile,
      VAPID_PRIVATE_KEY_VARIABLE,
      env,
    );
    if (!secret.value) {
      return {
        keys: null,
        problem: `VAPID private key: ${secret.problem ?? 'missing'}`,
      };
    }
    let publicKey: string;
    try {
      publicKey = publicKeyOf(secret.value);
    } catch {
      return {
        keys: null,
        problem: 'The VAPID private key is not a base64url P-256 key',
      };
    }
    if (config.publicKey && config.publicKey !== publicKey) {
      return {
        keys: null,
        problem: 'VAPID_PUBLIC_KEY does not belong to the VAPID private key',
      };
    }
    return {
      keys: { publicKey, privateKey: normalizedPrivateKey(secret.value) },
      problem: null,
    };
  }
  if (dataDir === ':memory:') {
    return { keys: generate(), problem: null };
  }
  const file = join(dataDir, VAPID_KEY_FILE_NAME);
  try {
    if (existsSync(file)) {
      if ((statSync(file).mode & 0o077) !== 0) {
        logger.warn(`${file} was readable by others; restricting it to 0600`);
        chmodSync(file, 0o600);
      }
      const stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<
        Record<string, unknown>
      >;
      if (typeof stored['privateKey'] !== 'string') {
        return { keys: null, problem: `${file} has no private key` };
      }
      return {
        keys: {
          privateKey: normalizedPrivateKey(stored['privateKey']),
          publicKey: publicKeyOf(stored['privateKey']),
        },
        problem: null,
      };
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const keys = generate();
    // `wx`: never overwrite keys another process wrote meanwhile.
    writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    chmodSync(file, 0o600);
    logger.log(`Generated VAPID keys for Web Push in ${file}`);
    return { keys, problem: null };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      keys: null,
      problem: `The VAPID keys in ${file} could not be read or created${
        typeof code === 'string' ? ` (${code})` : ''
      }`,
    };
  }
}
