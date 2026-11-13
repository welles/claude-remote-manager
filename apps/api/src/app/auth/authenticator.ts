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
import { isLoopback, loopbackPeerUid } from './peer-credentials';

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
 * - the credential endpoint of session clones (session process token);
 * - the GitHub webhook (signature over the body with a secret sessions
 *   never get; see `pr-automation/webhook.controller.ts`). Sessions may not
 *   call it: they have no reason to, and nothing they send is trusted.
 * `sessions`: processes of sessions may call it.
 */
export const AUTH_EXEMPT_ROUTES: readonly {
  method: string;
  path: string;
  sessions: boolean;
}[] = [
  { method: 'GET', path: '/api/health', sessions: true },
  { method: 'POST', path: '/api/git/credentials', sessions: true },
  { method: 'POST', path: '/api/github/webhook', sessions: false },
];

export type AuthVerdict =
  | { ok: true; email: string | null }
  | {
      ok: false;
      status: 401 | 403;
      reason: AccessFailure | 'session_process_refused';
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

/**
 * Decides whether a request (or WebSocket upgrade) may reach the API:
 *
 * 1. With separate users, connections over loopback from a process of the
 *    session user are refused, except for the routes sessions need (the
 *    credential endpoint). Sessions cannot call the management API, e.g.
 *    push without the user's approval, whatever the auth mode.
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
    private readonly peerUid: typeof loopbackPeerUid = loopbackPeerUid,
  ) {}

  async check(
    method: string,
    path: string,
    headers: IncomingHttpHeaders,
    socket: Pick<Socket, 'remoteAddress' | 'remotePort' | 'localPort'>,
  ): Promise<AuthVerdict> {
    const exempt = AUTH_EXEMPT_ROUTES.find(
      (route) =>
        route.method === method.toUpperCase() &&
        route.path === path.replace(/\/+$/, ''),
    );
    if (
      this.isolation.mode === 'separate-users' &&
      !exempt?.sessions &&
      isLoopback(socket.remoteAddress) &&
      socket.remotePort !== undefined &&
      socket.localPort !== undefined &&
      this.peerUid(socket.remotePort, socket.localPort) ===
        this.isolation.sessionUser.uid
    ) {
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
    const token =
      header(headers, 'cf-access-jwt-assertion') ??
      cookie(headers, 'CF_Authorization');
    try {
      const identity = await this.verifier.verify(token);
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
