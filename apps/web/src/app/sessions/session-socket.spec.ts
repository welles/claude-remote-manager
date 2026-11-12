import { TestBed } from '@angular/core/testing';
import {
  SESSION_PROTOCOL_VERSION,
  type ServerMessage,
} from '@claude-remote-manager/shared-types';
import {
  RECONNECT_DELAYS,
  SessionSocket,
  WEBSOCKET_FACTORY,
} from './session-socket';
import { FakeWebSocket, fakeWebSocketFactory } from './testing/fake-websocket';

describe('SessionSocket', () => {
  let socket: SessionSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: WEBSOCKET_FACTORY, useValue: fakeWebSocketFactory },
      ],
    });
    socket = TestBed.inject(SessionSocket);
  });

  afterEach(() => vi.useRealTimers());

  it('connects lazily to /api/ws and forwards server frames', () => {
    expect(FakeWebSocket.instances).toHaveLength(0);
    const received: ServerMessage[] = [];
    socket.messages$.subscribe((message) => received.push(message));

    socket.connect();
    socket.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.last.url).toBe(`ws://${location.host}/api/ws`);

    FakeWebSocket.last.open();
    expect(socket.connected()).toBe(true);
    FakeWebSocket.last.receive({
      type: 'hello',
      protocolVersion: SESSION_PROTOCOL_VERSION,
    });
    expect(received).toEqual([
      { type: 'hello', protocolVersion: SESSION_PROTOCOL_VERSION },
    ]);
  });

  it('does not send while disconnected', () => {
    expect(socket.send({ type: 'interrupt', sessionId: 's' })).toBe(false);
    socket.connect();
    expect(socket.send({ type: 'interrupt', sessionId: 's' })).toBe(false);
    FakeWebSocket.last.open();
    expect(socket.send({ type: 'interrupt', sessionId: 's' })).toBe(true);
    expect(FakeWebSocket.last.sent).toEqual([
      { type: 'interrupt', sessionId: 's' },
    ]);
  });

  it('reconnects with backoff and subscribes again', () => {
    socket.subscribe('s1');
    socket.subscribe('s2');
    socket.unsubscribe('s2');
    const first = FakeWebSocket.last;
    first.open();
    expect(first.sent).toEqual([{ type: 'subscribe', sessionId: 's1' }]);

    first.close();
    expect(socket.connected()).toBe(false);
    vi.advanceTimersByTime(RECONNECT_DELAYS[0] - 1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // The second attempt fails as well: the delay grows.
    FakeWebSocket.last.close();
    vi.advanceTimersByTime(RECONNECT_DELAYS[1]);
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.sent).toEqual([
      { type: 'subscribe', sessionId: 's1' },
    ]);
  });

  it('stops on an unknown protocol version', () => {
    socket.connect();
    FakeWebSocket.last.open();
    FakeWebSocket.last.receive({
      type: 'hello',
      protocolVersion: SESSION_PROTOCOL_VERSION + 1,
    });
    expect(socket.incompatible()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
