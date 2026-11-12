import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type {
  SessionEvent,
  SessionEventInput,
} from '@claude-remote-manager/shared-types';
import { WEBSOCKET_FACTORY } from './session-socket';
import { SessionView } from './session-view';
import { FakeWebSocket, fakeWebSocketFactory } from './testing/fake-websocket';
import { sessionDto } from './testing/session-dto';

const LOG = 'log-1';
let seq = 0;
const event = (input: SessionEventInput): SessionEvent =>
  ({ ...input, seq: ++seq, at: '2026-01-01T00:00:00Z' }) as SessionEvent;

describe('SessionView', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    FakeWebSocket.instances = [];
    window.scrollTo = vi.fn();
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'sessions/:id', component: SessionView }]),
        { provide: WEBSOCKET_FACTORY, useValue: fakeWebSocketFactory },
      ],
    }).compileComponents();
  });

  afterEach(() => vi.useRealTimers());

  const open = async () => {
    const router = TestBed.inject(Router);
    const { RouterTestingHarness } = await import('@angular/router/testing');
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/sessions/s1', SessionView);
    const socket = FakeWebSocket.last;
    socket.open();
    await harness.fixture.whenStable();
    const element = harness.routeNativeElement as HTMLElement;
    const text = (testId: string) =>
      element
        .querySelector(`[data-testid="${testId}"]`)
        ?.textContent?.replace(/\s+/g, ' ')
        .trim();
    return { harness, socket, element, text, router };
  };

  it('subscribes and renders the history and live events', async () => {
    const { harness, socket, element, text } = await open();
    expect(socket.sent).toEqual([{ type: 'subscribe', sessionId: 's1' }]);

    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session: sessionDto({ status: 'running' }),
      events: [
        event({ type: 'user.message', id: 'u1', text: 'Reply with pong' }),
        event({
          type: 'context.usage',
          context: {
            model: 'haiku',
            usedTokens: 1500,
            maxTokens: 200_000,
            percentage: 0.75,
            updatedAt: '',
          },
        }),
      ],
    });
    await harness.fixture.whenStable();
    expect(text('status')).toBe('Running');
    expect(text('usage')).toBe('1.5k tokens · $0.01');
    expect(text('context')).toBe('Context 1.5k / 200k (0.8%)');
    expect(element.querySelector('.user-message')?.textContent).toBe(
      'Reply with pong',
    );
    expect(text('interrupt')).toBe('Stop');

    socket.receive({
      type: 'session.event',
      sessionId: 's1',
      event: event({
        type: 'assistant.delta',
        messageId: 'm1',
        blockIndex: 0,
        text: '**po',
        parentToolUseId: null,
      }),
    });
    socket.receive({
      type: 'session.event',
      sessionId: 's1',
      event: event({
        type: 'assistant.text',
        messageId: 'm1',
        blockIndex: 0,
        text: '**pong**',
        parentToolUseId: null,
      }),
    });
    socket.receive({
      type: 'session.event',
      sessionId: 'other',
      event: event({ type: 'user.message', id: 'x', text: 'not mine' }),
    });
    socket.receive({
      type: 'session.event',
      sessionId: 's1',
      event: event({ type: 'session.status', status: 'waiting' }),
    });
    await harness.fixture.whenStable();

    expect(element.querySelector('.assistant-text strong')?.textContent).toBe(
      'pong',
    );
    expect(element.textContent).not.toContain('not mine');
    expect(text('status')).toBe('Waiting');
    expect(text('interrupt')).toBeUndefined();
  });

  it('catches up after a reconnect with only the newer events', async () => {
    const { harness, socket, element } = await open();
    const first = event({
      type: 'user.message',
      id: 'u1',
      text: 'Reply with pong',
    });
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      session: sessionDto({ status: 'running' }),
      events: [first],
      drafts: [],
    });
    const delta = event({
      type: 'assistant.delta',
      messageId: 'm1',
      blockIndex: 0,
      text: 'p',
      parentToolUseId: null,
    });
    socket.receive({ type: 'session.event', sessionId: 's1', event: delta });
    await harness.fixture.whenStable();

    socket.close();
    vi.advanceTimersByTime(1000);
    const reconnected = FakeWebSocket.last;
    expect(reconnected).not.toBe(socket);
    reconnected.open();
    expect(reconnected.sent).toEqual([
      {
        type: 'subscribe',
        sessionId: 's1',
        after: { logId: LOG, seq: delta.seq },
      },
    ]);

    reconnected.receive({
      type: 'session.history',
      logId: LOG,
      complete: false,
      session: sessionDto({ status: 'running' }),
      events: [event({ type: 'notice', level: 'info', text: 'Compacted' })],
      drafts: [
        { messageId: 'm1', blockIndex: 0, text: 'pon', parentToolUseId: null },
      ],
    });
    await harness.fixture.whenStable();
    expect(element.querySelector('.user-message')?.textContent).toBe(
      'Reply with pong',
    );
    expect(element.querySelectorAll('.assistant-text')).toHaveLength(1);
    expect(element.querySelector('.assistant-text')?.textContent?.trim()).toBe(
      'pon',
    );
    expect(element.querySelector('.notice')?.textContent).toBe('Compacted');

    // A new log (server restart) replaces everything.
    reconnected.receive({
      type: 'session.history',
      logId: 'log-2',
      complete: true,
      session: sessionDto(),
      events: [first],
      drafts: [],
    });
    await harness.fixture.whenStable();
    expect(element.querySelectorAll('.assistant-text')).toHaveLength(0);
    expect(element.querySelector('.notice')).toBeNull();
  });

  it('sends messages and interrupts', async () => {
    const { harness, socket, element, text } = await open();
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session: sessionDto({ status: 'running' }),
      events: [],
    });
    await harness.fixture.whenStable();

    const input = element.querySelector(
      '[data-testid="message-input"]',
    ) as HTMLTextAreaElement;
    input.value = 'Again';
    input.dispatchEvent(new Event('input'));
    await harness.fixture.whenStable();
    (
      element.querySelector('[data-testid="send"]') as HTMLButtonElement
    ).click();
    (
      element.querySelector('[data-testid="interrupt"]') as HTMLButtonElement
    ).click();

    const [, send, interrupt] = socket.sent as Record<string, unknown>[];
    expect(send).toMatchObject({
      type: 'message.send',
      sessionId: 's1',
      text: 'Again',
    });
    expect(interrupt).toMatchObject({ type: 'interrupt', sessionId: 's1' });

    socket.receive({
      type: 'error',
      requestId: interrupt['requestId'] as string,
      message: 'The session is not running',
    });
    await harness.fixture.whenStable();
    expect(text('error')).toBe('The session is not running');
  });

  it('shows tool calls compactly with their outcome', async () => {
    const { harness, socket, element } = await open();
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session: sessionDto(),
      events: [
        event({
          type: 'tool.call',
          messageId: 'm',
          toolUseId: 't1',
          name: 'Bash',
          input: { command: 'touch a' },
          parentToolUseId: null,
        }),
        event({
          type: 'permission.denied',
          toolUseId: 't1',
          toolName: 'Bash',
          input: { command: 'touch a' },
          message: 'Approval dialogs are not implemented yet',
          reason: 'no_approval_ui',
        }),
      ],
    });
    await harness.fixture.whenStable();
    const summary = element.querySelector('.tool summary');
    expect(summary?.querySelector('.tool-name')?.textContent).toBe('Bash');
    expect(summary?.querySelector('.tool-summary')?.textContent).toBe(
      'touch a',
    );
    expect(summary?.querySelector('.tool-state')?.textContent?.trim()).toBe(
      'denied',
    );
    expect(element.querySelector('.tool-denied')?.textContent).toContain(
      'not implemented',
    );
  });
});
