import { WebSocket } from 'ws';
import {
  SESSION_PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type SessionDto,
} from '@claude-remote-manager/shared-types';
import { startTestApp, type TestApp } from '../testing/test-app';
import { SESSIONS_WS_PATH } from './sessions.gateway';
import {
  flush,
  resultMessage,
  type FakeAgentRunner,
} from './testing/fake-agent';

/** A WebSocket client that records server frames. */
class TestClient {
  readonly received: ServerMessage[] = [];
  private readonly socket: WebSocket;
  readonly opened: Promise<void>;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', (data) =>
      this.received.push(JSON.parse(data.toString()) as ServerMessage),
    );
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(message: ClientMessage | Record<string, unknown> | string): void {
    this.socket.send(
      typeof message === 'string' ? message : JSON.stringify(message),
    );
  }

  async next<T extends ServerMessage['type']>(
    type: T,
    predicate: (message: Extract<ServerMessage, { type: T }>) => boolean = () =>
      true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const index = this.received.findIndex(
        (message) =>
          message.type === type &&
          predicate(message as Extract<ServerMessage, { type: T }>),
      );
      if (index >= 0) {
        return this.received.splice(index, 1)[0] as Extract<
          ServerMessage,
          { type: T }
        >;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No ${type} frame received`);
  }

  close(): void {
    this.socket.close();
  }
}

describe('SessionsGateway', () => {
  let testApp: TestApp;
  let runner: FakeAgentRunner;
  let url: string;
  let client: TestClient;

  beforeEach(async () => {
    testApp = await startTestApp();
    runner = testApp.runner;
    url = `http://${testApp.host}`;
    client = new TestClient(`ws://${testApp.host}${SESSIONS_WS_PATH}`);
    await client.opened;
  });

  afterEach(async () => {
    client.close();
    await testApp.close();
  });

  const createSession = async (): Promise<SessionDto> => {
    const response = await fetch(`${url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Reply with pong' }),
    });
    expect(response.status).toBe(201);
    await flush();
    return (await response.json()) as SessionDto;
  };

  it('greets with the protocol version', async () => {
    expect(await client.next('hello')).toEqual({
      type: 'hello',
      protocolVersion: SESSION_PROTOCOL_VERSION,
    });
  });

  it('sends the history on subscribe, then live events', async () => {
    const session = await createSession();
    expect((await client.next('session.updated')).session.id).toBe(session.id);

    client.send({ type: 'subscribe', sessionId: session.id, requestId: 'r1' });
    const history = await client.next('session.history');
    expect(history.session.id).toBe(session.id);
    expect(history.events.map((event) => event.type)).toEqual([
      'session.status',
      'user.message',
    ]);
    await client.next('ack', (ack) => ack.requestId === 'r1');

    runner.last.emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'm1', content: [{ type: 'text', text: 'pong' }] },
    });
    const live = await client.next('session.event');
    expect(live).toMatchObject({
      sessionId: session.id,
      event: { type: 'assistant.text', text: 'pong', seq: 3 },
    });
  });

  it('accepts messages and reports errors with the request ID', async () => {
    const session = await createSession();
    runner.last.emit(resultMessage(1, 0.001));
    await flush();

    client.send({
      type: 'message.send',
      sessionId: session.id,
      id: 'msg-2',
      text: 'Again',
      requestId: 'r2',
    });
    await client.next('ack', (ack) => ack.requestId === 'r2');
    expect(runner.last.sent.at(-1)).toEqual({ id: 'msg-2', text: 'Again' });

    client.send({ type: 'subscribe', sessionId: 'missing', requestId: 'r3' });
    expect(
      await client.next('error', (error) => error.requestId === 'r3'),
    ).toMatchObject({
      message: 'Session missing not found',
    });

    client.send('not json');
    expect(
      await client.next('error', (error) => error.requestId === null),
    ).toMatchObject({
      message: 'Invalid frame',
    });

    client.send({
      type: 'permission.respond',
      sessionId: session.id,
      requestId: 'r4',
    });
    expect(
      await client.next('error', (error) => error.requestId === 'r4'),
    ).toMatchObject({
      message: expect.stringContaining('not supported'),
    });
  });

  it('serves sessions and limits over REST', async () => {
    const session = await createSession();
    const list = (await (await fetch(`${url}/api/sessions`)).json()) as {
      sessions: SessionDto[];
    };
    expect(list.sessions.map((s) => s.id)).toEqual([session.id]);
    expect((await fetch(`${url}/api/sessions/${session.id}`)).status).toBe(200);
    expect((await fetch(`${url}/api/sessions/unknown`)).status).toBe(404);
    expect(
      (
        await fetch(`${url}/api/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: '' }),
        })
      ).status,
    ).toBe(400);
    expect(await (await fetch(`${url}/api/limits`)).json()).toEqual({
      windows: [],
      subscriptionType: null,
      updatedAt: null,
    });
  });

  it('stops running sessions when the application shuts down', async () => {
    const session = await createSession();
    const run = runner.last;
    await testApp.app.close();
    expect(run.closed).toBe(true);
    expect(session.status).toBe('running');
  });
});
