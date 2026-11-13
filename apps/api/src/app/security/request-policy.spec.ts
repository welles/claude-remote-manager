import { hostName, RequestPolicy } from './request-policy';

describe('RequestPolicy', () => {
  const policy = new RequestPolicy({
    allowedOrigins: ['http://localhost:4200', 'https://crm.example.com'],
    allowedHosts: ['crm.internal'],
  });
  const check = (
    method: string,
    headers: Record<string, string>,
    upgrade = false,
  ) => policy.check(method, headers, upgrade);

  it('accepts same-origin requests', () => {
    expect(
      check('POST', {
        host: 'localhost:8080',
        origin: 'http://localhost:8080',
      }),
    ).toEqual({ ok: true });
    expect(
      check(
        'GET',
        { host: 'crm.internal', origin: 'https://crm.internal' },
        true,
      ),
    ).toEqual({ ok: true });
  });

  it('accepts allowlisted origins', () => {
    expect(
      check('POST', {
        host: 'localhost:3000',
        origin: 'http://localhost:4200',
      }),
    ).toEqual({ ok: true });
    expect(
      check('POST', {
        host: 'crm.example.com',
        origin: 'https://crm.example.com',
      }),
    ).toEqual({ ok: true });
  });

  it('refuses foreign and opaque origins, also for GET', () => {
    for (const origin of ['https://evil.example', 'null', 'not a url']) {
      expect(check('POST', { host: 'localhost:8080', origin })).toMatchObject({
        ok: false,
        status: 403,
      });
    }
    expect(
      check('GET', { host: 'localhost:8080', origin: 'https://evil.example' }),
    ).toMatchObject({ ok: false });
    // Same host name, other port: another origin.
    expect(
      check('POST', {
        host: 'localhost:8080',
        origin: 'http://localhost:9999',
      }),
    ).toMatchObject({ ok: false });
  });

  it('refuses unknown hosts (DNS rebinding)', () => {
    expect(check('GET', { host: 'evil.example' })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      check('POST', {
        host: 'evil.example:8080',
        origin: 'http://evil.example:8080',
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(check('GET', {})).toMatchObject({ ok: false, status: 400 });
  });

  it('accepts loopback names and configured hosts', () => {
    for (const host of [
      'localhost',
      '127.0.0.1:8080',
      '[::1]:3000',
      'app.localhost',
      'crm.internal:443',
      'crm.example.com',
    ]) {
      expect(check('GET', { host })).toEqual({ ok: true });
    }
  });

  it('accepts non-browser clients without Origin', () => {
    expect(check('POST', { host: 'localhost' })).toEqual({ ok: true });
    expect(check('GET', { host: 'localhost' }, true)).toEqual({ ok: true });
  });

  it('refuses cross-site browser requests without Origin', () => {
    const headers = { host: 'localhost', 'sec-fetch-site': 'cross-site' };
    expect(check('POST', headers)).toMatchObject({ ok: false, status: 403 });
    expect(check('GET', headers, true)).toMatchObject({ ok: false });
    expect(check('GET', headers)).toEqual({ ok: true });
    expect(
      check('POST', { host: 'localhost', 'sec-fetch-site': 'same-origin' }),
    ).toEqual({ ok: true });
  });
});

describe('RequestPolicy and Sec-Fetch-Site', () => {
  const policy = new RequestPolicy({
    allowedOrigins: ['https://tools.example.com'],
    allowedHosts: ['crm.example.com'],
  });
  const api = (headers: Record<string, string>, method = 'GET') =>
    policy.check(method, { host: 'crm.example.com', ...headers }, false, true);

  it('accepts API requests of the app itself, typed URLs and non-browsers', () => {
    for (const site of ['same-origin', 'none']) {
      expect(api({ 'sec-fetch-site': site })).toEqual({ ok: true });
      expect(api({ 'sec-fetch-site': site }, 'POST')).toEqual({ ok: true });
    }
    expect(api({})).toEqual({ ok: true });
  });

  it('refuses same-site and cross-site API requests, also GETs without Origin', () => {
    // E.g. <img src="https://crm.example.com/api/..."> on a preview page.
    expect(api({ 'sec-fetch-site': 'same-site' })).toEqual({
      ok: false,
      status: 403,
      reason: 'Same-site request',
    });
    expect(api({ 'sec-fetch-site': 'cross-site' })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      policy.check(
        'GET',
        { host: 'crm.example.com', 'sec-fetch-site': 'same-site' },
        true,
        true,
      ),
    ).toMatchObject({ ok: false });
  });

  it('keeps the web app’s pages reachable from other sites (Access redirects back)', () => {
    expect(
      policy.check('GET', {
        host: 'crm.example.com',
        'sec-fetch-site': 'cross-site',
      }),
    ).toEqual({ ok: true });
  });

  it('exempts origins allowed on purpose', () => {
    expect(
      api({
        origin: 'https://tools.example.com',
        'sec-fetch-site': 'same-site',
      }),
    ).toEqual({ ok: true });
  });
});

describe('RequestPolicy with previews', () => {
  const policy = new RequestPolicy({
    allowedOrigins: [],
    allowedHosts: ['crm.example.com'],
    previewDomain: 'preview.localhost',
  });

  it('never takes a preview host for the app, also under .localhost', () => {
    for (const host of [
      'preview.localhost',
      'demo-1-5173.preview.localhost:3000',
      'a.b.preview.localhost.',
    ]) {
      expect(policy.check('GET', { host })).toMatchObject({
        ok: false,
        status: 403,
      });
    }
    expect(policy.check('GET', { host: 'app.localhost:3000' })).toEqual({
      ok: true,
    });
  });

  it('refuses requests from preview pages', () => {
    expect(
      policy.check(
        'GET',
        {
          host: 'localhost:3000',
          origin: 'http://demo-1-5173.preview.localhost:3000',
        },
        true,
      ),
    ).toMatchObject({ ok: false, status: 403 });
  });
});

describe('hostName', () => {
  it('strips ports and brackets', () => {
    expect(hostName('Example.COM:8080')).toBe('example.com');
    expect(hostName('[::1]:3000')).toBe('::1');
    expect(hostName('localhost')).toBe('localhost');
  });
});
