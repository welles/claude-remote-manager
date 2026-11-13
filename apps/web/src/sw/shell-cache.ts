/**
 * Caching rules of the service worker for the offline shell.
 *
 * - The app shell (`index.html`) is fetched from the network first; only
 *   when that fails (offline, no answer within {@link NAVIGATION_TIMEOUT_MS},
 *   or an error page of the tunnel in front because the server is down) the
 *   cached one is used. A redirect is passed to the browser untouched:
 *   that is how an expired Cloudflare Access session leads to its login.
 * - Only the app's own page is cached as shell: an answer that was
 *   redirected, is not HTML, or is not the app (e.g. the Access login page,
 *   served under the app's URL) is never stored.
 * - The built files (scripts, styles, fonts, icons) are cached as they are
 *   loaded; hashed file names are served from the cache first. The app
 *   preloads all its pages after the start, so all of them are cached; the
 *   oldest files go once there are more than {@link MAX_ASSETS}.
 * - `/api` is never cached: the session list's last known state is kept by
 *   the app itself and shown marked as stale.
 */

export const SHELL_CACHE = 'crm-shell-v1';
export const ASSET_CACHE = 'crm-assets-v1';
export const SHELL_KEY = '/index.html';
/** Wait this long for the network before starting from the cached shell. */
export const NAVIGATION_TIMEOUT_MS = 4000;

/**
 * Built files kept at most; the oldest go first (a build has about 30, so
 * the files of the last few builds stay).
 */
export const MAX_ASSETS = 200;

/** Marker of the app's own page (see index.html). */
export const APP_MARKER = '<app-root';

/** Requests the service worker handles itself (same origin, GET, not the API). */
export function handledRequest(
  request: { method: string; url: string },
  origin: string,
): boolean {
  if (request.method !== 'GET') {
    return false;
  }
  const url = new URL(request.url);
  return (
    url.origin === origin &&
    !url.pathname.startsWith('/api/') &&
    url.pathname !== '/api' &&
    !url.pathname.startsWith('/cdn-cgi/') &&
    url.pathname !== '/sw.js'
  );
}

/** Whether an answer may be kept at all: the app's own, not redirected. */
export function storable(response: Response): boolean {
  return (
    response.ok &&
    response.status === 200 &&
    response.type === 'basic' &&
    !response.redirected
  );
}

/** Whether a navigation answer is the app shell (and may be cached as such). */
export async function isAppShell(response: Response): Promise<boolean> {
  if (
    !storable(response) ||
    !(response.headers.get('Content-Type') ?? '').includes('text/html')
  ) {
    return false;
  }
  const text = await response.clone().text();
  return text.includes(APP_MARKER);
}

/**
 * The app's server is down although something answers in front of it (the
 * tunnel's or proxy's error page): start from the cached shell instead.
 */
export function serverDown(response: Response): boolean {
  return [502, 503, 504, 520, 521, 522, 523, 524, 530].includes(
    response.status,
  );
}

/** Built files with a content hash in their name never change. */
export function isHashedAsset(pathname: string): boolean {
  return /-[A-Za-z0-9_-]{8}\.(js|css|woff2?|ttf)$/.test(pathname);
}
