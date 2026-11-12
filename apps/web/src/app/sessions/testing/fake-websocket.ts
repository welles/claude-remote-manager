import type { ServerMessage } from '@claude-remote-manager/shared-types';

/** A WebSocket stand-in that records sent frames. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readyState: number = WebSocket.CONNECTING;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  static get last(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) {
      throw new Error('No socket created');
    }
    return socket;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }
}

export const fakeWebSocketFactory = (url: string) =>
  new FakeWebSocket(url) as unknown as WebSocket;
