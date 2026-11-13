import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { Authenticator } from './auth/authenticator';
import { GuardedWsAdapter } from './security/guarded-ws-adapter';
import { RequestPolicy } from './security/request-policy';

/**
 * Content Security Policy of the web app (everything outside `/api`; the
 * API's own content sets its own). Defense in depth against content that
 * reaches the page (Markdown, file names, diffs): scripts only from the
 * app's own files (the build inlines none; critical CSS inlining, which
 * adds an inline script, is off), nothing loaded or contacted elsewhere,
 * frames only from the app's origin (the viewer's sandboxed HTML and PDFs),
 * and the app itself not framed. Styles need `'unsafe-inline'`: Angular
 * adds component styles as `<style>` elements at runtime.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Largest accepted JSON request body. */
export const MAX_BODY_SIZE = '1mb';

/**
 * Settings shared by the server and tests. The app must be created with
 * `bodyParser: false`: only JSON bodies are parsed (see RequestPolicy).
 */
export function configureApp(app: NestExpressApplication): void {
  app.setGlobalPrefix('api');
  // Before everything else, also the static web app: see Authenticator.
  const authenticator = app.get(Authenticator);
  app.use((request: Request, response: Response, next: NextFunction) => {
    authenticator
      .check(request.method, request.path, request.headers, request.socket)
      .then((verdict) => {
        if (verdict.ok) {
          next();
          return;
        }
        response.status(verdict.status);
        if (verdict.status === 401) {
          response.setHeader('WWW-Authenticate', 'CloudflareAccess');
        }
        response.json({
          statusCode: verdict.status,
          reason: verdict.reason,
          message: verdict.message,
        });
      })
      .catch(next);
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!/^\/api(\/|$)/.test(request.path)) {
      response.setHeader('Content-Security-Policy', APP_CSP);
      response.setHeader('X-Content-Type-Options', 'nosniff');
    }
    next();
  });
  app.useBodyParser('json', { limit: MAX_BODY_SIZE });
  // Plain WebSockets for streaming session events (see SessionsGateway),
  // with the same origin checks as HTTP requests.
  app.useWebSocketAdapter(
    new GuardedWsAdapter(app, app.get(RequestPolicy), authenticator),
  );
}
