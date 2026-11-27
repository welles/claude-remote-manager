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
  waitFor,
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

const MSG_2 = '2b1f4c2e-8f3a-4d6b-9c1e-0a7d5e3f2b10';
const MSG_3 = '3c2e5d3f-9a4b-4e7c-8d2f-1b8e6f4a3c21';

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

  let projects = 0;
  /** Creates a session in a new project and waits until Claude started. */
  const createSession = async (): Promise<SessionDto> => {
    const runs = runner.runs.length;
    const response = await fetch(`${url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Reply with pong',
        newProject: { name: `project-${++projects}` },
      }),
    });
    expect(response.status).toBe(201);
    await waitFor(() => runner.runs.length > runs);
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
      // fetch (creates the project's mirror), clone, done
      'prepare.progress',
      'prepare.progress',
      'prepare.progress',
      'prepare.progress',
      'prepare.progress',
      'session.status',
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
      event: { type: 'assistant.text', text: 'pong', seq: 9 },
    });
  });

  it('resubscribes incrementally with a known log position', async () => {
    const session = await createSession();
    client.send({ type: 'subscribe', sessionId: session.id });
    const full = await client.next('session.history');
    expect(full.complete).toBe(true);
    const seq = full.events.at(-1)?.seq ?? 0;

    runner.last.emit(resultMessage(1, 0.001));
    await client.next('session.event', (m) => m.event.type === 'turn.result');

    client.send({
      type: 'subscribe',
      sessionId: session.id,
      after: { logId: full.logId, seq },
    });
    const part = await client.next('session.history');
    expect(part).toMatchObject({ complete: false, logId: full.logId });
    expect(part.events[0].seq).toBe(seq + 1);
    expect(part.events.map((event) => event.type)).toContain('turn.result');
  });

  it('accepts messages and reports errors with the request ID', async () => {
    const session = await createSession();
    runner.last.emit(resultMessage(1, 0.001));
    await flush();

    client.send({
      type: 'message.send',
      sessionId: session.id,
      id: MSG_2,
      text: 'Again',
      requestId: 'r2',
    });
    await client.next('ack', (ack) => ack.requestId === 'r2');
    expect(runner.last.sent.at(-1)).toEqual({ id: MSG_2, text: 'Again' });

    client.send({
      type: 'subscribe',
      sessionId: '00000000-0000-4000-8000-000000000000',
      requestId: 'r3',
    });
    expect(
      await client.next('error', (error) => error.requestId === 'r3'),
    ).toMatchObject({
      message: 'Session 00000000-0000-4000-8000-000000000000 not found',
    });

    client.send('not json');
    expect(
      await client.next('error', (error) => error.requestId === null),
    ).toMatchObject({
      message: 'Invalid frame: not JSON',
    });

    // Malformed frames get a 400-style error instead of crashing a handler.
    const malformed: [string, Record<string, unknown>][] = [
      [
        'r5',
        { type: 'message.send', sessionId: session.id, id: 'x', text: 'a' },
      ],
      [
        'r6',
        { type: 'message.send', sessionId: session.id, id: MSG_3, text: 5 },
      ],
      ['r7', { type: 'subscribe', sessionId: 42 }],
      ['r8', { type: 'interrupt' }],
      ['r9', { type: 'nonsense' }],
    ];
    for (const [requestId, frame] of malformed) {
      client.send({ ...frame, requestId });
      expect(
        (await client.next('error', (error) => error.requestId === requestId))
          .message,
      ).toMatch(/must be|Unknown frame type/);
    }
    client.send('[1, 2]');
    expect(
      await client.next('error', (error) => error.requestId === null),
    ).toMatchObject({ message: 'frame must be a JSON object' });
    expect(runner.last.sent).toHaveLength(2);

    client.send({
      type: 'permission.respond',
      sessionId: session.id,
      requestId: 'r4',
    });
    expect(
      await client.next('error', (error) => error.requestId === 'r4'),
    ).toMatchObject({
      message: 'permissionRequestId must be a UUID',
    });
  });

  it('shows approval requests to every client; the first answer counts', async () => {
    const session = await createSession();
    const other = new TestClient(`ws://${testApp.host}${SESSIONS_WS_PATH}`);
    await other.opened;
    for (const each of [client, other]) {
      each.send({ type: 'subscribe', sessionId: session.id });
      await each.next('session.history');
    }
    const decision = runner.last.options.canUseTool(
      'Bash',
      { command: 'rm -r build' },
      { signal: new AbortController().signal, toolUseID: 't1', requestId: 'x' },
    );
    const requests = await Promise.all(
      [client, other].map((each) =>
        each.next(
          'session.event',
          (frame) => frame.event.type === 'permission.request',
        ),
      ),
    );
    const request = requests[0].event;
    if (request.type !== 'permission.request') {
      throw new Error('unexpected');
    }
    expect(requests[1].event).toEqual(request);
    // The session list sees that it waits for an approval.
    expect(
      (
        await other.next(
          'session.updated',
          (frame) => frame.session.waitingFor === 'permission',
        )
      ).session.status,
    ).toBe('waiting');
    const pending = await fetch(
      `${url}/api/sessions/${session.id}/permission-requests`,
    );
    expect(await pending.json()).toEqual({ requests: [request] });

    other.send({
      type: 'permission.respond',
      sessionId: session.id,
      permissionRequestId: request.requestId,
      decision: 'deny',
      message: 'Keep the build',
      requestId: 'p1',
    });
    await other.next('ack', (ack) => ack.requestId === 'p1');
    for (const each of [client, other]) {
      expect(
        (
          await each.next(
            'session.event',
            (frame) => frame.event.type === 'permission.resolved',
          )
        ).event,
      ).toMatchObject({ decision: 'deny', message: 'Keep the build' });
    }
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' });

    // A late answer (REST, e.g. from a notification) changes nothing.
    const late = await fetch(
      `${url}/api/sessions/${session.id}/permission-requests/${request.requestId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allow' }),
      },
    );
    expect(late.status).toBe(200);
    expect(await late.json()).toMatchObject({
      alreadyResolved: true,
      resolved: { decision: 'deny' },
    });
    other.close();
  });

  it('answers approval requests, changes settings and removes queued messages over REST', async () => {
    const session = await createSession();
    const decision = runner.last.options.canUseTool(
      'WebFetch',
      { url: 'https://example.com' },
      { signal: new AbortController().signal, toolUseID: 't1', requestId: 'x' },
    );
    let requests: { requestId: string }[] = [];
    await waitFor(async () => {
      const response = await fetch(
        `${url}/api/sessions/${session.id}/permission-requests`,
      );
      requests = ((await response.json()) as { requests: typeof requests })
        .requests;
      return requests.length === 1;
    });
    const path = `${url}/api/sessions/${session.id}/permission-requests/${requests[0].requestId}`;
    const post = (body: unknown) =>
      fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ decision: 'perhaps' })).status).toBe(400);
    const answered = await post({ decision: 'allow' });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({
      alreadyResolved: false,
      resolved: { decision: 'allow', cause: 'user' },
    });
    await expect(decision).resolves.toMatchObject({ behavior: 'allow' });
    expect(
      (
        await fetch(
          `${url}/api/sessions/${session.id}/permission-requests/${MSG_2}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'allow' }),
          },
        )
      ).status,
    ).toBe(404);

    const patched = await fetch(`${url}/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonnet', permissionMode: 'plan' }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      model: 'sonnet',
      permissionMode: 'plan',
    });
    expect(
      (
        await fetch(`${url}/api/sessions/${session.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ permissionMode: 'yolo' }),
        })
      ).status,
    ).toBe(400);

    // Queued while the turn runs, removed before it ends.
    client.send({
      type: 'message.send',
      sessionId: session.id,
      id: MSG_2,
      text: 'Later',
      requestId: 'q1',
    });
    await client.next('ack', (ack) => ack.requestId === 'q1');
    const removed = await fetch(
      `${url}/api/sessions/${session.id}/queued-messages/${MSG_2}`,
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(204);
    expect(
      (
        await fetch(
          `${url}/api/sessions/${session.id}/queued-messages/${MSG_2}`,
          { method: 'DELETE' },
        )
      ).status,
    ).toBe(409);
  });

  it('ends sessions over WebSocket and REST', async () => {
    const session = await createSession();
    client.send({
      type: 'session.end',
      sessionId: session.id,
      requestId: 'e1',
    });
    await client.next('ack', (ack) => ack.requestId === 'e1');
    expect(runner.last.closed).toBe(true);
    const update = await client.next(
      'session.updated',
      (m) => m.session.status === 'finished',
    );
    expect(update.session.id).toBe(session.id);

    const second = await createSession();
    const response = await fetch(`${url}/api/sessions/${second.id}/end`, {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as SessionDto).status).toBe('finished');
  });

  it('serves sessions and limits over REST', async () => {
    const session = await createSession();
    const list = (await (await fetch(`${url}/api/sessions`)).json()) as {
      sessions: SessionDto[];
    };
    expect(list.sessions.map((s) => s.id)).toEqual([session.id]);
    expect((await fetch(`${url}/api/sessions/${session.id}`)).status).toBe(200);
    expect((await fetch(`${url}/api/sessions/unknown`)).status).toBe(404);
    // No first message is waiting for a decision.
    for (const action of ['pending-message/send', 'setup/rerun']) {
      expect(
        (
          await fetch(`${url}/api/sessions/${session.id}/${action}`, {
            method: 'POST',
          })
        ).status,
      ).toBe(409);
    }
    client.send({
      type: 'pending.send',
      sessionId: session.id,
      requestId: 'p1',
    });
    expect(
      (await client.next('error', (m) => m.requestId === 'p1')).message,
    ).toContain('no first message waiting');
    expect(
      (
        await fetch(`${url}/api/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: '' }),
        })
      ).status,
    ).toBe(400);
    for (const body of [
      '[1]',
      '{"prompt": 1}',
      '{"prompt": "x", "title": 2}',
      'null',
    ]) {
      const response = await fetch(`${url}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(response.status).toBe(400);
    }
    const badMessage = await fetch(
      `${url}/api/sessions/${session.id}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x', id: 'nope' }),
      },
    );
    expect(badMessage.status).toBe(400);
    expect(await (await fetch(`${url}/api/limits`)).json()).toEqual({
      accounts: [
        {
          accountId: 'main',
          windows: [],
          subscriptionType: null,
          updatedAt: null,
        },
      ],
    });
  });

  it('stops running sessions when the application shuts down', async () => {
    const session = await createSession();
    const run = runner.last;
    expect(session.status).toBe('preparing');
    await testApp.close();
    expect(run.closed).toBe(true);
  });
});
