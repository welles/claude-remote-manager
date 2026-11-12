import { HttpException, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';
import type { Subscription } from 'rxjs';
import type { RawData, WebSocket } from 'ws';
import {
  SESSION_PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from '@claude-remote-manager/shared-types';
import { LimitsService } from '../limits/limits.service';
import { SessionsService } from './sessions.service';

/** Path of the WebSocket endpoint (outside Nest's global `/api` prefix). */
export const SESSIONS_WS_PATH = '/api/ws';

interface ClientState {
  subscriptions: Set<string>;
}

/**
 * Streams session events to the web app, see `session-events.ts` in the
 * shared types for the protocol. Clients subscribe to sessions; session
 * and limit updates go to every client.
 */
@WebSocketGateway({ path: SESSIONS_WS_PATH })
export class SessionsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(SessionsGateway.name);
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly subscriptions: Subscription[];

  constructor(
    private readonly sessions: SessionsService,
    limits: LimitsService,
  ) {
    this.subscriptions = [
      sessions.events$.subscribe(({ sessionId, event }) => {
        for (const [client, state] of this.clients) {
          if (state.subscriptions.has(sessionId)) {
            this.send(client, { type: 'session.event', sessionId, event });
          }
        }
      }),
      sessions.updates$.subscribe((session) =>
        this.broadcast({ type: 'session.updated', session }),
      ),
      limits.changes$.subscribe((limits) =>
        this.broadcast({ type: 'account.limits', limits }),
      ),
    ];
  }

  handleConnection(client: WebSocket): void {
    this.clients.set(client, { subscriptions: new Set() });
    client.on('message', (data) => void this.handleFrame(client, data));
    this.send(client, {
      type: 'hello',
      protocolVersion: SESSION_PROTOCOL_VERSION,
    });
  }

  handleDisconnect(client: WebSocket): void {
    this.clients.delete(client);
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
    for (const client of this.clients.keys()) {
      client.close(1001, 'Server shutting down');
    }
  }

  private async handleFrame(client: WebSocket, data: RawData): Promise<void> {
    let message: ClientMessage;
    try {
      message = JSON.parse(data.toString()) as ClientMessage;
      if (typeof message?.type !== 'string') {
        throw new Error('missing type');
      }
    } catch {
      this.send(client, {
        type: 'error',
        requestId: null,
        message: 'Invalid frame',
      });
      return;
    }
    const requestId =
      typeof message.requestId === 'string' ? message.requestId : null;
    try {
      await this.dispatch(client, message);
      if (requestId) {
        this.send(client, { type: 'ack', requestId });
      }
    } catch (error) {
      if (!(error instanceof HttpException)) {
        this.logger.error(`Handling ${message.type} failed`, error);
      }
      this.send(client, {
        type: 'error',
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async dispatch(
    client: WebSocket,
    message: ClientMessage,
  ): Promise<void> {
    const state = this.clients.get(client);
    if (!state) {
      return;
    }
    switch (message.type) {
      case 'subscribe': {
        const { session, events } = await this.sessions.history(
          message.sessionId,
        );
        // No await between taking the history and subscribing: no event
        // can fall into the gap.
        state.subscriptions.add(message.sessionId);
        this.send(client, { type: 'session.history', session, events });
        return;
      }
      case 'unsubscribe':
        state.subscriptions.delete(message.sessionId);
        return;
      case 'message.send':
        await this.sessions.send(message.sessionId, {
          id: message.id,
          text: message.text,
        });
        return;
      case 'interrupt':
        await this.sessions.interrupt(message.sessionId);
        return;
      case 'permission.respond':
        throw new Error('Permission requests are not supported yet');
      default:
        throw new Error(
          `Unknown frame type ${(message as { type: string }).type}`,
        );
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const client of this.clients.keys()) {
      this.send(client, message);
    }
  }

  private send(client: WebSocket, message: ServerMessage): void {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(message));
    }
  }
}
