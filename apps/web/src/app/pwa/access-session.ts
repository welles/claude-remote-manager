import {
  HttpErrorResponse,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { tap } from 'rxjs';

/**
 * State of the sign-in (Cloudflare Access) as far as the app can tell:
 * - `ok`: the API answers;
 * - `expired`: the Access session ran out; API calls end at the Access
 *   login (a redirect, or a 401/403 from Access or the API's own token
 *   check). The app asks to sign in again instead of failing silently;
 * - `offline`: the server cannot be reached.
 */
export type AccessState = 'ok' | 'expired' | 'offline';

/** Reasons of the API's own refusals for a missing or expired Access token. */
const ACCESS_REASONS = new Set([
  'access_token_missing',
  'access_token_expired',
  'access_token_invalid',
  'access_email_not_allowed',
]);

/** Probe, replaceable in tests. */
export const ACCESS_PROBE = new InjectionToken<() => Promise<AccessState>>(
  'ACCESS_PROBE',
  { providedIn: 'root', factory: () => probeAccess },
);

/**
 * Asks the health endpoint without following redirects. The API never
 * redirects it and does not check a token there, so a redirect or a
 * 401/403 comes from Cloudflare Access in front: the sign-in expired. With
 * `AUTH_MODE=none` (no Access) it simply answers.
 */
export async function probeAccess(
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<AccessState> {
  try {
    const response = await fetchFn('/api/health', {
      redirect: 'manual',
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (
      response.type === 'opaqueredirect' ||
      response.status === 401 ||
      response.status === 403
    ) {
      return 'expired';
    }
    return 'ok';
  } catch {
    return 'offline';
  }
}

/** The sign-in state and the way back in. */
@Injectable({ providedIn: 'root' })
export class AccessSession {
  private readonly probe = inject(ACCESS_PROBE);
  private checking: Promise<AccessState> | null = null;

  readonly state = signal<AccessState>('ok');

  /** Something failed oddly: find out whether the sign-in expired. */
  check(): Promise<AccessState> {
    this.checking ??= this.probe()
      .then((state) => {
        this.state.set(state);
        return state;
      })
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  /** The API said the Access token is missing or expired. */
  expired(): void {
    this.state.set('expired');
  }

  /** The API answered normally. */
  reachable(): void {
    if (this.state() !== 'ok') {
      this.state.set('ok');
    }
  }

  /**
   * Signs in again: a full navigation to this page goes through Access
   * (login, then back here). The service worker passes the redirect on and
   * never keeps the login page.
   */
  signIn(): void {
    location.assign(location.href);
  }
}

/** Watches API answers for an expired Access session. */
export const accessInterceptor: HttpInterceptorFn = (request, next) => {
  const access = inject(AccessSession);
  if (!request.url.startsWith('/api/')) {
    return next(request);
  }
  return next(request).pipe(
    tap({
      next: () => access.reachable(),
      error: (error: unknown) => {
        if (!(error instanceof HttpErrorResponse)) {
          return;
        }
        const reason = (error.error as { reason?: unknown } | null)?.reason;
        if (typeof reason === 'string' && ACCESS_REASONS.has(reason)) {
          access.expired();
        } else if (
          error.status === 0 ||
          error.status === 401 ||
          error.status === 403
        ) {
          // A redirect to the Access login fails as a network error.
          void access.check();
        }
      },
    }),
  );
};
