import type { IncomingMessage } from 'node:http';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import type { Authenticator } from '../auth/authenticator';
import type { RequestPolicy } from './request-policy';

/**
 * WebSocket adapter that applies the {@link RequestPolicy} to every upgrade
 * request; refused upgrades get an HTTP error and no connection.
 */
export class GuardedWsAdapter extends WsAdapter {
  private readonly guardLogger = new Logger(GuardedWsAdapter.name);

  constructor(
    app: INestApplicationContext,
    private readonly policy: RequestPolicy,
    private readonly authenticator: Authenticator,
  ) {
    super(app);
  }

  override create(port: number, options: Record<string, unknown> = {}) {
    return super.create(port, {
      ...options,
      verifyClient: (
        info: { req: IncomingMessage },
        callback: (result: boolean, code?: number, message?: string) => void,
      ) => {
        const verdict = this.policy.check('GET', info.req.headers, true);
        if (!verdict.ok) {
          this.guardLogger.warn(`Refused WebSocket upgrade: ${verdict.reason}`);
          callback(false, verdict.status, verdict.reason);
          return;
        }
        const path = new URL(info.req.url ?? '/', 'http://x').pathname;
        this.authenticator
          .check('GET', path, info.req.headers, info.req.socket)
          .then((auth) => {
            if (auth.ok) {
              callback(true);
            } else {
              this.guardLogger.warn(
                `Refused WebSocket upgrade: ${auth.reason}`,
              );
              callback(false, auth.status, auth.reason);
            }
          })
          .catch((error: unknown) => {
            this.guardLogger.error(
              `WebSocket authentication failed: ${String(error)}`,
            );
            callback(false, 500, 'Authentication failed');
          });
      },
    });
  }
}
