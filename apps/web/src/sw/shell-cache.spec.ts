import {
  handledRequest,
  isAppShell,
  isHashedAsset,
  serverDown,
} from './shell-cache';

const ORIGIN = 'https://crm.example.com';

/** A same-origin answer as the service worker sees it. */
const answer = (
  body: string,
  {
    status = 200,
    type = 'basic',
    redirected = false,
    contentType = 'text/html; charset=utf-8',
  } = {},
) => {
  const response = new Response(body, {
    status,
    headers: { 'Content-Type': contentType },
  });
  Object.defineProperty(response, 'type', { value: type });
  Object.defineProperty(response, 'redirected', { value: redirected });
  return response;
};

const SHELL =
  '<!doctype html><html><body><app-root></app-root><script src="main-AB12CD34.js" type="module"></script></body></html>';

describe('offline shell rules', () => {
  it('handle the app’s own pages and files, never the API', () => {
    expect(handledRequest({ method: 'GET', url: `${ORIGIN}/` }, ORIGIN)).toBe(
      true,
    );
    expect(
      handledRequest(
        { method: 'GET', url: `${ORIGIN}/main-AB12CD34.js` },
        ORIGIN,
      ),
    ).toBe(true);
    for (const url of [
      `${ORIGIN}/api/sessions`,
      `${ORIGIN}/api`,
      `${ORIGIN}/cdn-cgi/access/login`,
      `${ORIGIN}/sw.js`,
      'https://team.cloudflareaccess.com/login',
      // Previews of dev servers are other origins: never handled or cached.
      'https://demo-abc123-5173.preview.example.com/',
      'https://demo-abc123-5173.preview.example.com/main.js',
    ]) {
      expect([url, handledRequest({ method: 'GET', url }, ORIGIN)]).toEqual([
        url,
        false,
      ]);
    }
    expect(handledRequest({ method: 'POST', url: `${ORIGIN}/` }, ORIGIN)).toBe(
      false,
    );
  });

  it('keep only the app itself as shell, never a login page', async () => {
    expect(await isAppShell(answer(SHELL))).toBe(true);
    // The Access login page (or any other page) under the app's URL.
    expect(
      await isAppShell(answer('<html><body>Sign in with Google</body></html>')),
    ).toBe(false);
    expect(await isAppShell(answer(SHELL, { redirected: true }))).toBe(false);
    expect(
      await isAppShell(answer('', { type: 'opaqueredirect', status: 200 })),
    ).toBe(false);
    expect(await isAppShell(answer(SHELL, { status: 401 }))).toBe(false);
    expect(
      await isAppShell(answer(SHELL, { contentType: 'application/json' })),
    ).toBe(false);
  });

  it('start from the cache when the server behind the tunnel is down', () => {
    expect(serverDown(answer('', { status: 502 }))).toBe(true);
    expect(serverDown(answer('', { status: 530 }))).toBe(true);
    expect(serverDown(answer('', { status: 500 }))).toBe(false);
    expect(serverDown(answer(SHELL))).toBe(false);
  });

  it('recognize built files', () => {
    expect(isHashedAsset('/main-AB12CD34.js')).toBe(true);
    expect(isHashedAsset('/chunk-Dte_xnE9.js')).toBe(true);
    expect(isHashedAsset('/styles-A25BELI4.css')).toBe(true);
    expect(isHashedAsset('/manifest.webmanifest')).toBe(false);
    expect(isHashedAsset('/icons/icon-192.png')).toBe(false);
  });
});
