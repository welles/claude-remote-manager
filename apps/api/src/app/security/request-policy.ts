import { withinDomain } from '../config/app-config';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * Protection of the unauthenticated API against cross-site requests and DNS
 * rebinding. The app has no login of its own and drives an agent with
 * tools, so a request is only accepted when it comes from the app itself or
 * from a non-browser client:
 *
 * - Host: the `Host` header must name an allowed host (loopback names plus
 *   `ALLOWED_HOSTS` and the hosts of `ALLOWED_ORIGINS`). Stops DNS rebinding,
 *   where a foreign site resolves its own name to this server.
 * - Origin: when a request carries an `Origin` header (browsers send it on
 *   WebSocket upgrades and on every cross-site or non-GET fetch), it must be
 *   the same origin as `Host` or listed in `ALLOWED_ORIGINS`. `Origin: null`
 *   (sandboxed frames, file pages) is refused.
 * - `Sec-Fetch-Site`: API requests (`/api`, of any method) and WebSocket
 *   upgrades are accepted from browsers only as `same-origin` (the app
 *   itself, its service worker, its frames) or `none` (typed or
 *   bookmarked, e.g. a shown file opened in a new tab). `same-site`
 *   matters most: previews of dev servers are same-site with the app, so
 *   the browser attaches the app's cookies to their `<img>`, `<script>`
 *   and no-cors requests, which carry no `Origin`; the API does not rely on
 *   GET routes having no effect. Outside `/api` (the web app's pages, which
 *   Cloudflare Access redirects back to cross-site) only state-changing
 *   requests are refused this way. An origin in `ALLOWED_ORIGINS` is
 *   another site on purpose and exempt. Clients without these headers
 *   (curl, scripts, the container health check) are not browsers and
 *   cannot be abused by a web page; requiring them would add no security.
 * - Bodies must be JSON (checked in the middleware): HTML forms can only send
 *   urlencoded, multipart or text bodies without a CORS preflight.
 */
export interface RequestPolicyConfig {
  /** Full origins such as `https://crm.example.com`. */
  allowedOrigins: string[];
  /** Host names (without port) besides the loopback names. */
  allowedHosts: string[];
  /**
   * Domain of the preview hosts (`PREVIEW_URL`): its names are never the
   * app's, also not as `*.localhost` (the preview gateway answers them
   * before the app; this is the second line).
   */
  previewDomain?: string | null;
}

export type PolicyVerdict =
  | { ok: true }
  | { ok: false; status: 400 | 403; reason: string };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

/** Host name of a `Host` header or URL host, lowercase, without port and brackets. */
export function hostName(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) {
    return value.slice(1, value.indexOf(']'));
  }
  return value.replace(/:\d+$/, '');
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export class RequestPolicy {
  private readonly origins: Set<string>;
  private readonly hosts: Set<string>;
  private readonly previewDomain: string | null;

  constructor(config: RequestPolicyConfig) {
    this.previewDomain = config.previewDomain ?? null;
    this.origins = new Set(
      config.allowedOrigins.map((origin) => new URL(origin).origin),
    );
    this.hosts = new Set([
      ...LOOPBACK_HOSTS,
      ...config.allowedHosts.map(hostName),
      ...[...this.origins].map((origin) => hostName(new URL(origin).host)),
    ]);
  }

  /**
   * Checks a request. `upgrade` marks a WebSocket upgrade, which is treated
   * like a state-changing request; `api` a request to the API (`/api`).
   */
  check(
    method: string,
    headers: IncomingHttpHeaders,
    upgrade = false,
    api = false,
  ): PolicyVerdict {
    const host = header(headers, 'host');
    if (!host) {
      return { ok: false, status: 400, reason: 'Missing Host header' };
    }
    const name = hostName(host);
    if (this.inPreviewDomain(name)) {
      return {
        ok: false,
        status: 403,
        reason: `Host ${name} is a preview host`,
      };
    }
    if (!this.hosts.has(name) && !name.endsWith('.localhost')) {
      return { ok: false, status: 403, reason: `Host ${name} is not allowed` };
    }

    const origin = header(headers, 'origin');
    if (origin !== null) {
      const verdict = this.checkOrigin(origin, host);
      if (verdict !== 'same-origin') {
        // Refused, or another origin allowed on purpose.
        return verdict === 'allowlisted' ? { ok: true } : verdict;
      }
    }
    const fetchSite = header(headers, 'sec-fetch-site');
    const strict = api || upgrade || !SAFE_METHODS.has(method.toUpperCase());
    if (strict && fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
      return {
        ok: false,
        status: 403,
        reason: `${fetchSite === 'same-site' ? 'Same-site' : 'Cross-site'} request`,
      };
    }
    return { ok: true };
  }

  private inPreviewDomain(name: string): boolean {
    return (
      this.previewDomain !== null && withinDomain(name, this.previewDomain)
    );
  }

  private checkOrigin(
    origin: string,
    host: string,
  ): PolicyVerdict | 'same-origin' | 'allowlisted' {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return {
        ok: false,
        status: 403,
        reason: `Origin ${origin} is not allowed`,
      };
    }
    // Pages of previews never act on the app (also not if listed).
    if (this.inPreviewDomain(url.hostname.toLowerCase())) {
      return {
        ok: false,
        status: 403,
        reason: `Origin ${origin} is a preview`,
      };
    }
    // Same origin: the page was loaded from the host it talks to. The scheme
    // is not compared because TLS usually ends at the tunnel in front.
    if (url.host === host.trim().toLowerCase()) {
      return 'same-origin';
    }
    if (this.origins.has(url.origin)) {
      return 'allowlisted';
    }
    return {
      ok: false,
      status: 403,
      reason: `Origin ${origin} is not allowed`,
    };
  }
}
