import type { NestExpressApplication } from '@nestjs/platform-express';
import { raw, type NextFunction, type Request, type Response } from 'express';
import { Authenticator } from './auth/authenticator';
import {
  APP_CONFIG,
  type AppConfig,
  type PreviewConfig,
} from './config/app-config';
import { PreviewAccess } from './previews/preview-access';
import {
  installPreviewGateway,
  PreviewGateway,
} from './previews/preview-gateway';
import { PreviewsService } from './previews/previews.service';
import {
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_PATH,
} from './pr-automation/webhook.controller';
import { GuardedWsAdapter } from './security/guarded-ws-adapter';
import { RequestPolicy } from './security/request-policy';

/**
 * Content Security Policy of the web app (everything outside `/api`; the
 * API's own content sets its own). Defense in depth against content that
 * reaches the page (Markdown, file names, diffs): scripts only from the
 * app's own files (the build inlines none; critical CSS inlining, which
 * adds an inline script, is off), nothing loaded or contacted elsewhere,
 * frames only from the app's origin (the viewer's sandboxed HTML and PDFs)
 * and, with previews, the preview hosts (see {@link appCsp}), and the app
 * itself not framed. Styles need `'unsafe-inline'`: Angular adds
 * component styles as `<style>` elements at runtime.
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

/**
 * Source expression of all preview hosts, e.g.
 * `https://*.preview.example.com` (with the port in development, e.g.
 * `http://*.preview.localhost:3000`).
 */
export function previewFrameSource(previews: PreviewConfig): string {
  return `${previews.scheme}://*.${previews.domain}${previews.port ? `:${previews.port}` : ''}`;
}

/**
 * The app's CSP: {@link APP_CSP}, with previews on also allowing frames of
 * the preview hosts (the session view embeds running previews) and
 * nothing else.
 */
export function appCsp(previews: PreviewConfig | null): string {
  return previews
    ? APP_CSP.replace(
        "frame-src 'self'",
        `frame-src 'self' ${previewFrameSource(previews)}`,
      )
    : APP_CSP;
}

/** Largest accepted JSON request body. */
export const MAX_BODY_SIZE = '1mb';

/**
 * Settings shared by the server and tests. The app must be created with
 * `bodyParser: false`: only JSON bodies are parsed (see RequestPolicy).
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<AppConfig>(APP_CONFIG);
  // In front of everything: preview host names go to the dev servers and
  // never reach the app; the app's host names never reach a preview.
  if (config.previews) {
    const previews = app.get(PreviewsService);
    const server = app.getHttpServer();
    previews.attachServer(server);
    installPreviewGateway(
      server,
      new PreviewGateway(config.previews, previews, app.get(PreviewAccess)),
    );
  }
  const csp = appCsp(config.previews);
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
      response.setHeader('Content-Security-Policy', csp);
      response.setHeader('X-Content-Type-Options', 'nosniff');
    }
    next();
  });
  // The GitHub webhook's signature covers the raw body: read it as is
  // (JSON only, bounded) before the JSON parser would.
  app.use(
    WEBHOOK_PATH,
    raw({ type: 'application/json', limit: WEBHOOK_MAX_BODY_BYTES }),
  );
  app.useBodyParser('json', { limit: MAX_BODY_SIZE });
  // Plain WebSockets for streaming session events (see SessionsGateway),
  // with the same origin checks as HTTP requests.
  app.useWebSocketAdapter(
    new GuardedWsAdapter(app, app.get(RequestPolicy), authenticator),
  );
}
