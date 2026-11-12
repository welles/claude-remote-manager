import type { IncomingMessage } from 'node:http';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
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
        if (verdict.ok) {
          callback(true);
        } else {
          this.guardLogger.warn(`Refused WebSocket upgrade: ${verdict.reason}`);
          callback(false, verdict.status, verdict.reason);
        }
      },
    });
  }
}
