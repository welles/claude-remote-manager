import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { GitHubAppConfig } from '../config/app-config';
import { GitHubNotConfiguredError } from './github-errors';

/** Secret variable with the PEM key, as alternative to a key file. */
export const PRIVATE_KEY_VARIABLE = 'CRM_SECRET_GITHUB_APP_PRIVATE_KEY';

/** GitHub accepts JWTs of at most 10 minutes; 9 leave room for clock skew. */
const JWT_LIFETIME_S = 9 * 60;
/** Issued-at in the past, as GitHub recommends against clock drift. */
const JWT_BACKDATE_S = 60;

const base64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * The GitHub App's identity: App ID and private key, and the app JWTs made
 * from them. The key is read once at startup into a `KeyObject` (which
 * never prints its content) and lives only in this process; it is not
 * stored in the database, not logged, and child processes get neither the
 * key nor a JWT (they get no installation tokens either, except through
 * the credential endpoint for one repository at a time).
 *
 * Loading never throws: without configuration, or with an unreadable key,
 * the app runs without GitHub and reports the problem in the status.
 */
export class GitHubAppCredentials {
  private cachedJwt: { token: string; expiresAt: number } | null = null;

  private constructor(
    readonly appId: string | null,
    private readonly key: KeyObject | null,
    /** Why the app is not usable; `null` when it is. */
    readonly problem: string | null,
    private readonly now: () => number,
  ) {}

  static load(
    config: GitHubAppConfig | null,
    env: Record<string, string | undefined> = process.env,
    now: () => number = Date.now,
  ): GitHubAppCredentials {
    if (!config) {
      return new GitHubAppCredentials(
        null,
        null,
        'GITHUB_APP_ID is not set',
        now,
      );
    }
    let pem: string | undefined = env[PRIVATE_KEY_VARIABLE]?.trim()
      ? (env[PRIVATE_KEY_VARIABLE] as string)
      : undefined;
    try {
      if (pem === undefined) {
        if (!config.privateKeyFile) {
          return new GitHubAppCredentials(
            config.appId,
            null,
            `no private key: set GITHUB_APP_PRIVATE_KEY_FILE or ${PRIVATE_KEY_VARIABLE}`,
            now,
          );
        }
        pem = readFileSync(config.privateKeyFile, 'utf8');
      }
      const key = createPrivateKey({ key: pem, format: 'pem' });
      if (key.asymmetricKeyType !== 'rsa') {
        throw new Error('the private key is not an RSA key');
      }
      return new GitHubAppCredentials(config.appId, key, null, now);
    } catch (error) {
      // Messages of readFileSync/createPrivateKey never contain the key.
      const reason = error instanceof Error ? error.message : String(error);
      return new GitHubAppCredentials(
        config.appId,
        null,
        `the private key could not be read: ${reason}`,
        now,
      );
    } finally {
      pem = undefined;
    }
  }

  /** For tests: credentials with a given key. */
  static fromKey(
    appId: string,
    key: KeyObject,
    now: () => number = Date.now,
  ): GitHubAppCredentials {
    return new GitHubAppCredentials(appId, key, null, now);
  }

  get configured(): boolean {
    return this.key !== null && this.appId !== null;
  }

  /** A JWT for the app endpoints, reused until a minute before it expires. */
  jwt(): string {
    if (!this.key || !this.appId) {
      throw new GitHubNotConfiguredError(this.problem ?? undefined);
    }
    const nowS = Math.floor(this.now() / 1000);
    if (this.cachedJwt && this.cachedJwt.expiresAt - 60 > nowS) {
      return this.cachedJwt.token;
    }
    const expiresAt = nowS + JWT_LIFETIME_S;
    const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
      iat: nowS - JWT_BACKDATE_S,
      exp: expiresAt,
      iss: this.appId,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(this.key)
      .toString('base64url');
    this.cachedJwt = { token: `${unsigned}.${signature}`, expiresAt };
    return this.cachedJwt.token;
  }

  /** Keeps the key out of `console.log`, JSON and inspection. */
  toJSON(): Record<string, unknown> {
    return { appId: this.appId, configured: this.configured };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `GitHubAppCredentials(${this.appId ?? 'not configured'})`;
  }
}
