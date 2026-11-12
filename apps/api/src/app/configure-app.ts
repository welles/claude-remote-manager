import type { NestExpressApplication } from '@nestjs/platform-express';
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
  app.useBodyParser('json', { limit: MAX_BODY_SIZE });
  // Plain WebSockets for streaming session events (see SessionsGateway),
  // with the same origin checks as HTTP requests.
  app.useWebSocketAdapter(new GuardedWsAdapter(app, app.get(RequestPolicy)));
}
