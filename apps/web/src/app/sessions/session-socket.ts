import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import {
  SESSION_PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from '@claude-remote-manager/shared-types';

/** Creates the WebSocket; replaced in tests. */
export const WEBSOCKET_FACTORY = new InjectionToken<(url: string) => WebSocket>(
  'WEBSOCKET_FACTORY',
  { providedIn: 'root', factory: () => (url: string) => new WebSocket(url) },
);

/** Delays between reconnect attempts, in ms; the last one repeats. */
export const RECONNECT_DELAYS = [500, 1000, 2000, 5000, 10000];

/**
 * The WebSocket connection to the API (`/api/ws`). Connects on first use,
 * reconnects automatically and subscribes to the same sessions again, so
 * the server sends their full history once more.
 */
@Injectable({ providedIn: 'root' })
export class SessionSocket {
  private readonly createSocket = inject(WEBSOCKET_FACTORY);
  private socket: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly subscriptions = new Set<string>();
  private readonly incoming = new Subject<ServerMessage>();

  /** Whether the connection is open. */
  readonly connected = signal(false);
  /** Set when the server speaks a protocol version this app does not know. */
  readonly incompatible = signal(false);
  /** All frames from the server. */
  readonly messages$ = this.incoming.asObservable();

  /** Opens the connection if it is not open or opening yet. */
  connect(): void {
    if (this.socket || this.incompatible()) {
      return;
    }
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.createSocket(`${protocol}//${location.host}/api/ws`);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.connected.set(true);
      for (const sessionId of this.subscriptions) {
        this.send({ type: 'subscribe', sessionId });
      }
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (
        message.type === 'hello' &&
        message.protocolVersion !== SESSION_PROTOCOL_VERSION
      ) {
        this.incompatible.set(true);
        socket.close();
        return;
      }
      this.incoming.next(message);
    };
    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.connected.set(false);
      this.scheduleReconnect();
    };
  }

  /** Receive the history and live events of a session (also after reconnects). */
  subscribe(sessionId: string): void {
    this.subscriptions.add(sessionId);
    this.connect();
    this.send({ type: 'subscribe', sessionId });
  }

  unsubscribe(sessionId: string): void {
    this.subscriptions.delete(sessionId);
    this.send({ type: 'unsubscribe', sessionId });
  }

  /** Sends a frame; returns false if the connection is not open. */
  send(message: ClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.incompatible()) {
      return;
    }
    const delay =
      RECONNECT_DELAYS[Math.min(this.attempt, RECONNECT_DELAYS.length - 1)];
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
