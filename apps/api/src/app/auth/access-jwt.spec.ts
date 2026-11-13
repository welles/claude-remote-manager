import { normalizeTeamDomain } from './access-jwt';
import { AUD, FakeAccess } from './testing/fake-access';

describe('AccessJwtVerifier', () => {
  let access: FakeAccess;
  beforeEach(() => (access = new FakeAccess()));

  const reason = (promise: Promise<unknown>) =>
    promise.then(
      () => 'accepted',
      (error: { reason?: string }) => error.reason,
    );

  it('accepts a valid token and returns the identity', async () => {
    await expect(access.verifier().verify(access.token())).resolves.toEqual({
      email: 'ada@example.com',
      subject: 'user-1',
    });
    // Audience as a plain string is fine too.
    await expect(
      access.verifier().verify(access.token({ aud: AUD })),
    ).resolves.toMatchObject({ email: 'ada@example.com' });
  });

  it('caches the keys', async () => {
    const verifier = access.verifier();
    await verifier.verify(access.token());
    await verifier.verify(access.token());
    expect(access.fetches).toBe(1);
  });

  it.each([
    ['missing', null, 'access_token_missing'],
    ['malformed', 'abc.def', 'access_token_invalid'],
  ])('refuses a %s token', async (_, token, expected) => {
    expect(await reason(access.verifier().verify(token))).toBe(expected);
  });

  it('refuses expired, not yet valid and foreign tokens', async () => {
    const verifier = access.verifier();
    const now = Math.floor(Date.now() / 1000);
    expect(
      await reason(verifier.verify(access.token({ exp: now - 120 }))),
    ).toBe('access_token_expired');
    expect(await reason(verifier.verify(access.token({ exp: now - 30 })))).toBe(
      'accepted',
    );
    expect(
      await reason(verifier.verify(access.token({ nbf: now + 600 }))),
    ).toBe('access_token_invalid');
    expect(
      await reason(verifier.verify(access.token({ aud: ['other'] }))),
    ).toBe('access_token_invalid');
    expect(
      await reason(
        verifier.verify(
          access.token({ iss: 'https://evil.cloudflareaccess.com' }),
        ),
      ),
    ).toBe('access_token_invalid');
    expect(
      await reason(verifier.verify(access.token({ exp: undefined }))),
    ).toBe('access_token_invalid');
  });

  it('refuses tampered tokens, other algorithms and unknown keys', async () => {
    const verifier = access.verifier();
    const [header, , signature] = access.token().split('.');
    const forged = Buffer.from(
      JSON.stringify({
        iss: 'https://acme.cloudflareaccess.com',
        aud: [AUD],
        exp: 9e9,
      }),
    ).toString('base64url');
    expect(
      await reason(verifier.verify(`${header}.${forged}.${signature}`)),
    ).toBe('access_token_invalid');
    expect(
      await reason(verifier.verify(access.token({}, { alg: 'HS256' }))),
    ).toBe('access_token_invalid');
    expect(
      await reason(verifier.verify(access.token({}, { kid: 'stranger' }))),
    ).toBe('access_token_invalid');
  });

  it('follows key rotation without restart, refreshing at most every 30 s', async () => {
    let now = Date.now();
    const verifier = access.verifier(() => now);
    await verifier.verify(access.token());
    access.rotate('key-2');
    now += 31_000;
    await expect(
      verifier.verify(access.token({}, { kid: 'key-2' })),
    ).resolves.toBeTruthy();
    // The old key stays valid while Access still lists it.
    await expect(
      verifier.verify(access.token({}, { kid: 'key-1' })),
    ).resolves.toBeTruthy();
    expect(access.fetches).toBe(2);
    // Unknown keys do not cause a fetch per request.
    await reason(verifier.verify(access.token({}, { kid: 'nope' })));
    await reason(verifier.verify(access.token({}, { kid: 'nope' })));
    expect(access.fetches).toBe(2);
  });

  it('applies the email allowlist', async () => {
    access.config.allowedEmails = ['grace@example.com'];
    expect(await reason(access.verifier().verify(access.token()))).toBe(
      'access_email_not_allowed',
    );
    expect(
      await reason(
        access.verifier().verify(access.token({ email: 'Grace@Example.com' })),
      ),
    ).toBe('accepted');
    expect(
      await reason(
        access.verifier().verify(access.token({ email: undefined })),
      ),
    ).toBe('access_email_not_allowed');
  });

  it('normalizes team domains', () => {
    expect(normalizeTeamDomain('acme')).toBe(
      'https://acme.cloudflareaccess.com',
    );
    expect(normalizeTeamDomain('https://acme.cloudflareaccess.com/')).toBe(
      'https://acme.cloudflareaccess.com',
    );
    expect(() => normalizeTeamDomain('a b')).toThrow('CF_ACCESS_TEAM_DOMAIN');
  });
});
