import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { AccessJwtVerifier, type AccessConfig } from '../access-jwt';

export const TEAM = 'https://acme.cloudflareaccess.com';
export const AUD = 'aud-tag-1234';

const keyCache = new Map<
  string,
  { privateKey: KeyObject; publicKey: KeyObject }
>();
function keyPair(kid: string) {
  let pair = keyCache.get(kid);
  if (!pair) {
    pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    keyCache.set(kid, pair);
  }
  return pair;
}

/**
 * Cloudflare Access in memory: signs tokens with its current keys and
 * serves them as JWKS; `rotate` replaces the keys like Access does.
 */
export class FakeAccess {
  kids = ['key-1'];
  fetches = 0;
  readonly config: AccessConfig = {
    teamDomain: TEAM,
    audiences: [AUD],
    allowedEmails: [],
  };

  jwks = async (url: string) => {
    if (url !== `${TEAM}/cdn-cgi/access/certs`) {
      throw new Error(`unexpected URL ${url}`);
    }
    this.fetches++;
    return {
      keys: this.kids.map((kid) => ({
        ...keyPair(kid).publicKey.export({ format: 'jwk' }),
        kid,
        alg: 'RS256',
        use: 'sig',
      })),
    };
  };

  verifier(now?: () => number): AccessJwtVerifier {
    return new AccessJwtVerifier(this.config, this.jwks, now);
  }

  token(
    claims: Record<string, unknown> = {},
    { kid = this.kids[0], alg = 'RS256' }: { kid?: string; alg?: string } = {},
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const part = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg, kid, typ: 'JWT' })}.${part({
      iss: TEAM,
      aud: [AUD],
      email: 'ada@example.com',
      sub: 'user-1',
      iat: now,
      nbf: now,
      exp: now + 3600,
      type: 'app',
      ...claims,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(keyPair(kid).privateKey)
      .toString('base64url');
    return `${unsigned}.${signature}`;
  }

  rotate(kid: string): void {
    this.kids = [kid, ...this.kids];
  }
}
