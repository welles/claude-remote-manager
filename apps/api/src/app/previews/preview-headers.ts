import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

/**
 * Headers between the browser and a dev server. The dev server is to see
 * requests as if the browser talked to it on `localhost:<port>` directly
 * (dev servers check Host and Origin, and build URLs from them), and
 * nothing of the app or of Cloudflare: no Access token or cookie, no
 * forwarding headers, no Referer from the app.
 */

/** Hop-by-hop headers (RFC 9110 7.6.1), never forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Request headers the dev server never gets: what Cloudflare adds (the
 * Access token and identity, client IP and location), forwarding headers
 * (the proxy pretends to be the browser on localhost), and `Host`, which
 * is set anew.
 */
function droppedRequestHeader(name: string): boolean {
  return (
    name === 'host' ||
    name.startsWith('cf-') ||
    name === 'cdn-loop' ||
    name.startsWith('x-forwarded-') ||
    name === 'forwarded' ||
    name === 'x-real-ip' ||
    name === 'true-client-ip'
  );
}

/**
 * Cookies the dev server never gets: Cloudflare's, above all the Access
 * token (`CF_Authorization`), plus `CF_AppSession`, `CF_Binding`,
 * `__cf_bm`, `cf_clearance`.
 */
export function cloudflareCookie(name: string): boolean {
  return /^(cf_|__cf)/i.test(name);
}

/** The `Cookie` header without Cloudflare's cookies; `null` if none is left. */
export function filteredCookieHeader(value: string): string | null {
  const kept = value
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) {
        return false;
      }
      const index = part.indexOf('=');
      const name = (index >= 0 ? part.slice(0, index) : part).trim();
      return !cloudflareCookie(name);
    });
  return kept.length > 0 ? kept.join('; ') : null;
}

/** Header names the `Connection` header lists (also hop-by-hop). */
function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const value = headers['connection'];
  return new Set(
    (Array.isArray(value) ? value.join(',') : (value ?? ''))
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Where the browser and the dev server see the preview. */
export interface PreviewOrigins {
  /** The `Host` header the browser sent, e.g. `app-1-5173.preview.example.com`. */
  host: string;
  /** Origin of the preview for the browser, e.g. `https://app-1-5173.preview.example.com`. */
  public: string;
  /** The dev server's port on loopback. */
  port: number;
}

/** What the dev server takes as its own origin. */
export function localOrigin(port: number): string {
  return `http://localhost:${port}`;
}

/** An origin or URL on the preview host, rewritten to the local origin. */
function toLocal(value: string, origins: PreviewOrigins): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.host.toLowerCase() !== origins.host.toLowerCase()) {
    return null;
  }
  return `${localOrigin(origins.port)}${value === url.origin ? '' : url.pathname + url.search}`;
}

/**
 * Request headers for the dev server:
 * - `Host: localhost:<port>`; `Origin` and `Referer` of the preview itself
 *   become the local origin (so host checks and CSRF checks of dev
 *   servers pass as on localhost); a foreign `Origin` stays as it is (the
 *   dev server's own checks see it); a foreign `Referer` (e.g. the app's
 *   page that embeds the preview) is dropped;
 * - hop-by-hop headers dropped (WebSocket upgrades add theirs back),
 *   Cloudflare's headers and cookies and forwarding headers dropped.
 */
export function upstreamRequestHeaders(
  incoming: IncomingHttpHeaders,
  origins: PreviewOrigins,
  { upgrade = false }: { upgrade?: boolean } = {},
): OutgoingHttpHeaders {
  const listed = connectionTokens(incoming);
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (
      value === undefined ||
      HOP_BY_HOP.has(name) ||
      listed.has(name) ||
      droppedRequestHeader(name)
    ) {
      continue;
    }
    headers[name] = value;
  }
  headers['host'] = `localhost:${origins.port}`;
  const cookie = incoming['cookie'];
  delete headers['cookie'];
  if (typeof cookie === 'string') {
    const kept = filteredCookieHeader(cookie);
    if (kept) {
      headers['cookie'] = kept;
    }
  }
  const origin = incoming['origin'];
  if (typeof origin === 'string') {
    headers['origin'] = toLocal(origin, origins) ?? origin;
  }
  const referer = incoming['referer'];
  delete headers['referer'];
  if (typeof referer === 'string') {
    const local = toLocal(referer, origins);
    if (local) {
      headers['referer'] = local;
    }
  }
  if (upgrade) {
    headers['connection'] = 'Upgrade';
    headers['upgrade'] = incoming['upgrade'] ?? 'websocket';
  }
  return headers;
}

/** `localhost`, `127.0.0.1`, `[::1]` with the dev server's port. */
function isLocalHost(host: string, port: number): boolean {
  const lower = host.toLowerCase();
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(
    lower,
  );
}

/** `Location` pointing at the dev server's local origin → the preview's. */
export function rewriteLocation(
  value: string,
  origins: PreviewOrigins,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (!isLocalHost(url.host, origins.port)) {
    return value;
  }
  return `${origins.public}${url.pathname}${url.search}${url.hash}`;
}

/**
 * A `Set-Cookie` value without `Domain` attribute: the cookie belongs to
 * the preview host alone (dev servers set `Domain=localhost`, and a preview
 * must not set cookies for the parent domain, which the app shares).
 */
export function hostOnlyCookie(value: string): string {
  return value
    .split(';')
    .filter((part, index) => index === 0 || !/^\s*domain\s*=/i.test(part))
    .join(';');
}

/**
 * Response headers for the browser: hop-by-hop headers dropped, `Location`
 * back to the preview's origin, cookies host-only.
 */
export function clientResponseHeaders(
  incoming: IncomingHttpHeaders,
  origins: PreviewOrigins,
): OutgoingHttpHeaders {
  const listed = connectionTokens(incoming);
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name)) {
      continue;
    }
    headers[name] = value;
  }
  const location = incoming['location'];
  if (typeof location === 'string') {
    headers['location'] = rewriteLocation(location, origins);
  }
  const cookies = incoming['set-cookie'];
  if (cookies) {
    headers['set-cookie'] = cookies.map(hostOnlyCookie);
  }
  return headers;
}
