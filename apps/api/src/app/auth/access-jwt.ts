import {
  createPublicKey,
  createVerify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

/** Settings of Cloudflare Access verification. */
export interface AccessConfig {
  /** `https://<team>.cloudflareaccess.com`: issuer and host of the keys. */
  teamDomain: string;
  /** Application Audience (AUD) tags the token must carry (any of them). */
  audiences: string[];
  /** If not empty, only these email addresses (lowercase) are let in. */
  allowedEmails: string[];
}

/** Why a token was not accepted; machine-readable for the web app. */
export type AccessFailure =
  | 'access_token_missing'
  | 'access_token_expired'
  | 'access_token_invalid'
  | 'access_email_not_allowed';

export class AccessTokenError extends Error {
  constructor(
    readonly reason: AccessFailure,
    message: string,
  ) {
    super(message);
    this.name = 'AccessTokenError';
  }
}

export interface AccessIdentity {
  email: string | null;
  subject: string | null;
}

export type JwksFetcher = (url: string) => Promise<{ keys?: unknown[] }>;

/** Allowed clock difference for exp/nbf/iat. */
export const CLOCK_SKEW_S = 60;
/** Keys are re-read at least this often (Access rotates every 6 weeks). */
export const JWKS_MAX_AGE_MS = 60 * 60_000;
/** An unknown key ID triggers a re-read at most this often. */
export const JWKS_MIN_REFRESH_MS = 30_000;

/** `myteam`, `myteam.cloudflareaccess.com` or a URL → the issuer URL. */
export function normalizeTeamDomain(value: string): string {
  const host = value
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) {
    throw new Error(`CF_ACCESS_TEAM_DOMAIN: ${value} is not a host name`);
  }
  return `https://${host.includes('.') ? host : `${host}.cloudflareaccess.com`}`;
}

function decodePart(part: string): Record<string, unknown> {
  const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('not an object');
  }
  return value as Record<string, unknown>;
}

/**
 * Verifies Cloudflare Access JWTs (application tokens) as Cloudflare
 * documents it: RS256 signature with the team's current keys from
 * `/cdn-cgi/access/certs` (matched by `kid`; keys are cached and re-read
 * when a token names an unknown key, so rotations need no restart),
 * issuer = the team domain, audience = the application's AUD tag, and
 * the token's lifetime (exp/nbf/iat with a minute of clock skew).
 */
export class AccessJwtVerifier {
  private keys = new Map<string, KeyObject>();
  private loadedAt = 0;
  private attemptedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    readonly config: AccessConfig,
    private readonly fetchJwks: JwksFetcher = async (url) => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return (await response.json()) as { keys?: unknown[] };
    },
    private readonly now: () => number = Date.now,
  ) {}

  get certsUrl(): string {
    return `${this.config.teamDomain}/cdn-cgi/access/certs`;
  }

  async verify(token: string | null | undefined): Promise<AccessIdentity> {
    if (!token) {
      throw new AccessTokenError(
        'access_token_missing',
        'Sign in through Cloudflare Access',
      );
    }
    const parts = token.split('.');
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      if (parts.length !== 3) {
        throw new Error('not a JWT');
      }
      header = decodePart(parts[0]);
      payload = decodePart(parts[1]);
    } catch {
      throw new AccessTokenError('access_token_invalid', 'Malformed token');
    }
    if (header['alg'] !== 'RS256' || typeof header['kid'] !== 'string') {
      throw new AccessTokenError(
        'access_token_invalid',
        'Unexpected token algorithm or key',
      );
    }
    const key = await this.key(header['kid']);
    const valid = createVerify('RSA-SHA256')
      .update(`${parts[0]}.${parts[1]}`)
      .verify(key, Buffer.from(parts[2], 'base64url'));
    if (!valid) {
      throw new AccessTokenError('access_token_invalid', 'Bad signature');
    }
    if (payload['iss'] !== this.config.teamDomain) {
      throw new AccessTokenError('access_token_invalid', 'Wrong issuer');
    }
    const audiences = Array.isArray(payload['aud'])
      ? payload['aud']
      : [payload['aud']];
    if (!audiences.some((aud) => this.config.audiences.includes(String(aud)))) {
      throw new AccessTokenError('access_token_invalid', 'Wrong audience');
    }
    const nowS = this.now() / 1000;
    const exp = payload['exp'];
    if (typeof exp !== 'number') {
      throw new AccessTokenError(
        'access_token_invalid',
        'Token without expiry',
      );
    }
    if (exp + CLOCK_SKEW_S < nowS) {
      throw new AccessTokenError(
        'access_token_expired',
        'The Cloudflare Access session expired; sign in again',
      );
    }
    for (const claim of ['nbf', 'iat']) {
      const value = payload[claim];
      if (typeof value === 'number' && value - CLOCK_SKEW_S > nowS) {
        throw new AccessTokenError(
          'access_token_invalid',
          'Token not valid yet',
        );
      }
    }
    const email =
      typeof payload['email'] === 'string'
        ? payload['email'].toLowerCase()
        : null;
    if (
      this.config.allowedEmails.length > 0 &&
      (!email || !this.config.allowedEmails.includes(email))
    ) {
      throw new AccessTokenError(
        'access_email_not_allowed',
        `${email ?? 'This identity'} may not use this app`,
      );
    }
    return {
      email,
      subject: typeof payload['sub'] === 'string' ? payload['sub'] : null,
    };
  }

  /** The key with this ID; re-reads the keys if it is unknown or old. */
  private async key(kid: string): Promise<KeyObject> {
    const stale = this.now() - this.loadedAt > JWKS_MAX_AGE_MS;
    const mayRetry = this.now() - this.attemptedAt > JWKS_MIN_REFRESH_MS;
    if ((stale || !this.keys.has(kid)) && mayRetry) {
      try {
        await this.load();
      } catch (error) {
        if (this.keys.size === 0) {
          throw new AccessTokenError(
            'access_token_invalid',
            `Cloudflare Access keys unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    const key = this.keys.get(kid);
    if (!key) {
      throw new AccessTokenError('access_token_invalid', 'Unknown signing key');
    }
    return key;
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      this.attemptedAt = this.now();
      try {
        const jwks = await this.fetchJwks(this.certsUrl);
        const keys = new Map<string, KeyObject>();
        for (const entry of jwks.keys ?? []) {
          const jwk = entry as JsonWebKey & { kid?: string };
          if (jwk.kty === 'RSA' && typeof jwk.kid === 'string') {
            keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
          }
        }
        this.keys = keys;
        this.loadedAt = this.now();
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }
}
