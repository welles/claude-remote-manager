import type { IncomingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import { Logger } from '@nestjs/common';
import type { ProcessIsolation } from '../common/process-isolation';
import {
  AccessJwtVerifier,
  AccessTokenError,
  type AccessConfig,
  type AccessFailure,
} from './access-jwt';
import { loopbackPeer } from './peer-credentials';
import { heldByApiChild } from './session-processes';

/**
 * How the API authenticates requests (`AUTH_MODE`, no default):
 * - `cloudflare-access`: every request carries a Cloudflare Access JWT
 *   (header `Cf-Access-Jwt-Assertion`, cookie `CF_Authorization` as
 *   fallback), verified by the API itself;
 * - `none`: no authentication, for local development only.
 */
export type AuthConfig =
  | { mode: 'none' }
  | { mode: 'cloudflare-access'; access: AccessConfig };

export const AUTH_MODES = ['cloudflare-access', 'none'] as const;

/**
 * Routes without Access token, each with its own protection:
 * - the health check (container health probe, no data);
 * - the GitHub webhook (signature over the body with the webhook secret;
 *   see `pr-automation/webhook.controller.ts`). Sessions may not call it:
 *   they have no reason to.
 * - the GitHub token helper of session processes (the session's process
 *   token; see `sessions/session-github-tokens.service.ts`). Only session
 *   processes may call it.
 * `sessions`: whether processes of sessions may call it (`'only'`: nobody
 * else may).
 */
export const AUTH_EXEMPT_ROUTES: readonly {
  method: string;
  path: string;
  sessions: boolean | 'only';
}[] = [
  { method: 'GET', path: '/api/health', sessions: true },
  { method: 'POST', path: '/api/github/webhook', sessions: false },
  { method: 'POST', path: '/api/session-tokens/git', sessions: 'only' },
  { method: 'POST', path: '/api/session-tokens/gh', sessions: 'only' },
];

export type AuthVerdict =
  | { ok: true; email: string | null }
  | {
      ok: false;
      status: 401 | 403;
      reason:
        | AccessFailure
        | 'session_process_refused'
        | 'session_process_only';
      message: string;
    };

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/** Value of a cookie from a `Cookie` header. */
export function cookie(
  headers: IncomingHttpHeaders,
  name: string,
): string | null {
  for (const part of (header(headers, 'cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

/** The peer end of a connection the server accepted. */
export type PeerSocket = Pick<
  Socket,
  'remoteAddress' | 'remotePort' | 'localPort'
> &
  Partial<Pick<Socket, 'localAddress'>>;

/** Finds the client socket of a connection, see {@link loopbackPeer}. */
export type PeerLookup = typeof loopbackPeer;

/** Whether a socket (by inode) belongs to a process the API started. */
export type SessionSocketCheck = (inode: number) => boolean;

/**
 * Whether a connection comes from a session process. Only connections
 * made on this machine (inside the container) can: loopback or one of its
 * own addresses (its `eth0` address reaches the API's port too);
 * connections from elsewhere (a tunnel on another host, Docker's port
 * publishing) have no client socket in its tables.
 * - `separate-users`: the client socket belongs to the session user.
 * - `single-user`: sessions run as the API's user, so the client socket
 *   must belong to that user and to a process the API started (see
 *   {@link heldByApiChild}); the user's other programs on this machine
 *   (a browser, the dev server's proxy) are not refused.
 */
export function fromSessionProcess(
  isolation: ProcessIsolation,
  socket: PeerSocket,
  peer: PeerLookup = loopbackPeer,
  startedByApi: SessionSocketCheck = heldByApiChild,
  apiUid: number = process.getuid?.() ?? -1,
): boolean {
  if (socket.remotePort === undefined || socket.localPort === undefined) {
    return false;
  }
  const entry = peer(
    socket.remotePort,
    socket.localPort,
    socket.remoteAddress && socket.localAddress
      ? { client: socket.remoteAddress, server: socket.localAddress }
      : undefined,
  );
  if (!entry) {
    return false;
  }
  if (isolation.mode === 'separate-users') {
    return entry.uid === isolation.sessionUser.uid;
  }
  return entry.uid === apiUid && startedByApi(entry.inode);
}

/** The Access token of a request: header, else the cookie. */
export function accessToken(headers: IncomingHttpHeaders): string | null {
  return (
    header(headers, 'cf-access-jwt-assertion') ??
    cookie(headers, 'CF_Authorization')
  );
}

/**
 * Decides whether a request (or WebSocket upgrade) may reach the API:
 *
 * 1. Connections from session processes (see {@link fromSessionProcess})
 *    are refused, except for the routes sessions may use (the health
 *    check, the GitHub token helper); the token helper's routes refuse
 *    everyone else. Sessions do not call the management API, e.g. to answer
 *    their own approval requests, whatever the auth mode.
 * 2. Exempt routes need no Access token.
 * 3. `cloudflare-access`: a valid Access token is required.
 */
export class Authenticator {
  private readonly logger = new Logger(Authenticator.name);

  constructor(
    readonly config: AuthConfig,
    private readonly isolation: ProcessIsolation,
    readonly verifier: AccessJwtVerifier | null = config.mode ===
    'cloudflare-access'
      ? new AccessJwtVerifier(config.access)
      : null,
    private readonly peer: PeerLookup = loopbackPeer,
    private readonly startedByApi: SessionSocketCheck = heldByApiChild,
  ) {}

  async check(
    method: string,
    path: string,
    headers: IncomingHttpHeaders,
    socket: PeerSocket,
  ): Promise<AuthVerdict> {
    const exempt = AUTH_EXEMPT_ROUTES.find(
      (route) =>
        route.method === method.toUpperCase() &&
        route.path === path.replace(/\/+$/, ''),
    );
    const fromSession = fromSessionProcess(
      this.isolation,
      socket,
      this.peer,
      this.startedByApi,
    );
    if (exempt?.sessions === 'only' && !fromSession) {
      this.logger.warn(`Refused ${method} ${path}: not a session process`);
      return {
        ok: false,
        status: 403,
        reason: 'session_process_only',
        message: 'Only processes of sessions may call this route',
      };
    }
    if (!exempt?.sessions && fromSession) {
      this.logger.warn(`Refused ${method} ${path} from a session process`);
      return {
        ok: false,
        status: 403,
        reason: 'session_process_refused',
        message: 'Session processes may not call the management API',
      };
    }
    if (exempt || !this.verifier) {
      return { ok: true, email: null };
    }
    try {
      const identity = await this.verifier.verify(accessToken(headers));
      return { ok: true, email: identity.email };
    } catch (error) {
      if (error instanceof AccessTokenError) {
        return {
          ok: false,
          status: error.reason === 'access_email_not_allowed' ? 403 : 401,
          reason: error.reason,
          message: error.message,
        };
      }
      throw error;
    }
  }
}
