import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { Authenticator } from './auth/authenticator';
import { GuardedWsAdapter } from './security/guarded-ws-adapter';
import { RequestPolicy } from './security/request-policy';

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
  app.useBodyParser('json', { limit: MAX_BODY_SIZE });
  // Plain WebSockets for streaming session events (see SessionsGateway),
  // with the same origin checks as HTTP requests.
  app.useWebSocketAdapter(
    new GuardedWsAdapter(app, app.get(RequestPolicy), authenticator),
  );
}
