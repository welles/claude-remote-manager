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
import {
  parseClientFrame,
  PERMISSION_ANSWER_FIELDS,
  pick,
  SESSION_UPDATE_FIELDS,
} from './client-frames';
import { SessionsService } from './sessions.service';
import { ViewerPresence } from './viewer-presence';

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
    private readonly presence: ViewerPresence,
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
      sessions.deletions$.subscribe((sessionId) => {
        for (const state of this.clients.values()) {
          state.subscriptions.delete(sessionId);
        }
        this.broadcast({ type: 'session.deleted', sessionId });
      }),
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
    const state = this.clients.get(client);
    this.clients.delete(client);
    this.presence.remove(client);
    for (const sessionId of state?.subscriptions ?? []) {
      this.sessions.unsubscribe(sessionId);
    }
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
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      this.send(client, {
        type: 'error',
        requestId: null,
        message: 'Invalid frame: not JSON',
      });
      return;
    }
    // Echo the request ID in errors even if the rest of the frame is invalid.
    const rawRequestId = (raw as { requestId?: unknown } | null)?.requestId;
    const requestId =
      typeof rawRequestId === 'string' && rawRequestId.length <= 100
        ? rawRequestId
        : null;
    try {
      const message = parseClientFrame(raw);
      await this.dispatch(client, message);
      if (requestId) {
        this.send(client, { type: 'ack', requestId });
      }
    } catch (error) {
      if (!(error instanceof HttpException)) {
        this.logger.error('Handling a frame failed', error);
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
        const snapshot = await this.sessions.subscribe(
          message.sessionId,
          message.after,
        );
        if (!this.clients.has(client)) {
          // Disconnected while the history was loading.
          this.sessions.unsubscribe(message.sessionId);
          return;
        }
        if (state.subscriptions.has(message.sessionId)) {
          // Subscribed again (e.g. to catch up): count it once.
          this.sessions.unsubscribe(message.sessionId);
        }
        // No await between taking the snapshot and subscribing: no event
        // can fall into the gap.
        state.subscriptions.add(message.sessionId);
        this.send(client, { type: 'session.history', ...snapshot });
        return;
      }
      case 'unsubscribe':
        if (state.subscriptions.delete(message.sessionId)) {
          this.sessions.unsubscribe(message.sessionId);
        }
        return;
      case 'message.send':
        await this.sessions.send(message.sessionId, {
          id: message.id,
          text: message.text,
          attachmentIds: message.attachmentIds,
          references: message.references,
        });
        return;
      case 'interrupt':
        await this.sessions.interrupt(message.sessionId);
        return;
      case 'session.end':
        await this.sessions.end(message.sessionId);
        return;
      case 'pending.send':
        await this.sessions.sendPending(message.sessionId);
        return;
      case 'setup.rerun':
        await this.sessions.rerunSetup(message.sessionId);
        return;
      case 'permission.respond':
        await this.sessions.respondToPermission(
          message.sessionId,
          message.permissionRequestId,
          pick(message, PERMISSION_ANSWER_FIELDS),
        );
        return;
      case 'presence':
        this.presence.update(client, message.sessionId, message.active);
        return;
      case 'message.unqueue':
        await this.sessions.unqueue(message.sessionId, message.messageId);
        return;
      case 'queue.send':
        await this.sessions.sendQueuedNow(
          message.sessionId,
          message.messageId ?? null,
        );
        return;
      case 'session.update':
        await this.sessions.update(
          message.sessionId,
          pick(message, SESSION_UPDATE_FIELDS),
        );
        return;
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
