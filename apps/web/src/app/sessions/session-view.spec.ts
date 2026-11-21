import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type {
  SessionEvent,
  SessionEventInput,
} from '@claude-remote-manager/shared-types';
import { words } from '../testing/text';
import { Toasts } from '../ui/toasts';
import { WEBSOCKET_FACTORY } from './session-socket';
import { SessionView } from './session-view';
import { FakeWebSocket, fakeWebSocketFactory } from './testing/fake-websocket';
import {
  permissionRequest,
  permissionResolved,
} from './testing/permission-events';
import { pullRequestDto } from './testing/pull-request';
import { sessionDto } from './testing/session-dto';
import { preview } from '../previews/testing/preview';

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
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: WEBSOCKET_FACTORY, useValue: fakeWebSocketFactory },
      ],
    }).compileComponents();
  });

  afterEach(() => vi.useRealTimers());

  const open = async (url = '/sessions/s1') => {
    const router = TestBed.inject(Router);
    const { RouterTestingHarness } = await import('@angular/router/testing');
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url, SessionView);
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

  it('puts a file referenced from the file browser into the input', async () => {
    const { element, router } = await open(
      '/sessions/s1?mention=%40src%2Fa.ts',
    );
    const input = element.querySelector(
      '[data-testid="message-input"]',
    ) as HTMLTextAreaElement;
    expect(input.value).toBe('@src/a.ts ');
    expect(router.url).toBe('/sessions/s1');
  });

  it('takes only a single @ reference from a link, nothing else', async () => {
    const { element, router } = await open(
      '/sessions/s1?mention=%40x%0A%0ADo%20something%20else',
    );
    const input = element.querySelector(
      '[data-testid="message-input"]',
    ) as HTMLTextAreaElement;
    expect(input.value).toBe('');
    expect(router.url).toBe('/sessions/s1');
  });

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
    expect(text('usage')).toBe('1.5k tokens · $0.01 theoretical API cost');
    expect(text('context')).toBe('1.5k / 200k · 0.8%');
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
    expect(text('status')).toBe('Ready');
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

  it('offers the prompt suggestion of the last turn until a message is sent', async () => {
    const { harness, socket, element } = await open();
    const input = element.querySelector(
      '[data-testid="message-input"]',
    ) as HTMLTextAreaElement;
    const suggestion = () =>
      input.hasAttribute('data-suggestion') ? input.placeholder : undefined;
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session: sessionDto({ status: 'running' }),
      events: [
        { type: 'prompt.suggestion', text: 'Old', seq: 1, at: null },
        { type: 'user.message', id: 'u1', text: 'Hi', seq: 2, at: null },
        { type: 'prompt.suggestion', text: 'Run the tests', seq: 3, at: null },
      ],
    });
    await harness.fixture.whenStable();
    // Not while a turn runs.
    expect(suggestion()).toBeUndefined();

    socket.receive({
      type: 'session.event',
      sessionId: 's1',
      event: { type: 'session.status', status: 'waiting', seq: 4, at: null },
    });
    await harness.fixture.whenStable();
    expect(suggestion()).toBe('Run the tests');

    input.value = 'Something else';
    input.dispatchEvent(new Event('input'));
    await harness.fixture.whenStable();
    (
      element.querySelector('[data-testid="send"]') as HTMLButtonElement
    ).click();
    await harness.fixture.whenStable();
    // Gone right away, before the server confirms the message.
    expect(input.value).toBe('');
    expect(suggestion()).toBeUndefined();
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
    await harness.fixture.whenStable();
    expect(input.value).toBe('');
    expect(send).toMatchObject({
      type: 'message.send',
      sessionId: 's1',
      text: 'Again',
    });
    expect(interrupt).toMatchObject({ type: 'interrupt', sessionId: 's1' });

    (element.querySelector('[data-testid="end"]') as HTMLButtonElement).click();
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'session.end',
      sessionId: 's1',
    });

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
    const summary = element.querySelector('[data-testid="tool"] summary');
    expect(
      summary?.querySelector('[data-testid="tool-name"]')?.textContent,
    ).toBe('Bash');
    expect(
      summary?.querySelector('[data-testid="tool-summary"]')?.textContent,
    ).toBe('touch a');
    expect(
      summary?.querySelector('[data-tool-state]')?.textContent?.trim(),
    ).toBe('denied');
    expect(
      element.querySelector('[data-testid="tool-denied"]')?.textContent,
    ).toContain('not implemented');
  });

  it('folds a run of tool calls into one quiet row that opens to the calls', async () => {
    const { harness, socket, element } = await open();
    const call = (toolUseId: string, name = 'Bash') =>
      event({
        type: 'tool.call',
        messageId: 'm',
        toolUseId,
        name,
        input: { command: `echo ${toolUseId}` },
        parentToolUseId: null,
      });
    const result = (toolUseId: string, isError = false) =>
      event({
        type: 'tool.result',
        toolUseId,
        isError,
        content: 'out',
        truncated: false,
        parentToolUseId: null,
      });
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session: sessionDto(),
      events: [
        call('t1'),
        result('t1'),
        call('t2', 'Read'),
        result('t2', true),
        call('t3'),
        result('t3'),
        event({
          type: 'assistant.text',
          messageId: 'm2',
          blockIndex: null,
          text: 'Found it.',
          parentToolUseId: null,
        }),
      ],
    });
    await harness.fixture.whenStable();
    const group = element.querySelector(
      '[data-testid="tool-group"]',
    ) as HTMLDetailsElement;
    expect(group.open).toBe(false);
    const summary = group
      .querySelector('summary')
      ?.textContent?.replace(/\s+/g, ' ');
    expect(summary).toContain('3 tool calls');
    expect(summary).toContain('Bash 2 · Read');
    expect(summary).toContain('1 failed');
    expect(group.querySelectorAll('[data-testid="tool"]')).toHaveLength(3);
    // Claude's text stays outside, after the group.
    expect(group.nextElementSibling?.textContent).toContain('Found it.');
  });

  it("keeps a group's permission lines inside it and says what waits", async () => {
    const { harness, socket, element } = await open();
    const call = (toolUseId: string) =>
      event({
        type: 'tool.call',
        messageId: 'm',
        toolUseId,
        name: 'Bash',
        input: { command: `rm ${toolUseId}` },
        parentToolUseId: null,
      });
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session: sessionDto({ status: 'waiting', waitingFor: 'permission' }),
      events: [
        call('t1'),
        permissionRequest({ requestId: 'p1', toolUseId: 't1', seq: ++seq }),
        permissionResolved({ requestId: 'p1', toolUseId: 't1', seq: ++seq }),
        call('t2'),
        permissionRequest({ requestId: 'p2', toolUseId: 't2', seq: ++seq }),
      ],
    });
    await harness.fixture.whenStable();
    const group = element.querySelector('[data-testid="tool-group"]');
    expect(
      group?.querySelectorAll('[data-testid="permission-line"]'),
    ).toHaveLength(1);
    expect(
      element.querySelectorAll('[data-testid="permission-line"]'),
    ).toHaveLength(1);
    const summary = group
      ?.querySelector('summary')
      ?.textContent?.replace(/\s+/g, ' ');
    expect(summary).toContain('Bash rm t2');
    expect(summary).toContain('needs approval');
  });

  it("names a group's running call in its row", async () => {
    const { harness, socket, element } = await open();
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session: sessionDto({ status: 'running' }),
      events: [
        ...['t1', 't2'].map((toolUseId) =>
          event({
            type: 'tool.call',
            messageId: 'm',
            toolUseId,
            name: 'Bash',
            input: { command: `ls ${toolUseId}` },
            parentToolUseId: null,
          }),
        ),
        event({
          type: 'tool.result',
          toolUseId: 't1',
          isError: false,
          content: 'out',
          truncated: false,
          parentToolUseId: null,
        }),
      ],
    });
    await harness.fixture.whenStable();
    const summary = element
      .querySelector('[data-testid="tool-group"] summary')
      ?.textContent?.replace(/\s+/g, ' ');
    expect(summary).toContain('Bash ls t2');
    expect(summary).toContain('running');
  });

  it('shows git commands the app ran for autofix with their real outcome', async () => {
    const { harness, socket, element } = await open();
    const call = (toolUseId: string) =>
      event({
        type: 'tool.call',
        messageId: 'm',
        toolUseId,
        name: 'Bash',
        input: { command: 'git commit -m x && git push' },
        parentToolUseId: null,
      });
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session: sessionDto(),
      events: [
        call('t1'),
        event({
          type: 'tool.by_app',
          toolUseId: 't1',
          outcome: 'succeeded',
          summary: 'Committed; pushed claude/x of acme/app at 1a2b3c4',
        }),
        event({
          type: 'tool.result',
          toolUseId: 't1',
          isError: false,
          content: 'Done by the app',
          truncated: false,
          parentToolUseId: null,
        }),
        call('t2'),
        event({
          type: 'tool.by_app',
          toolUseId: 't2',
          outcome: 'failed',
          summary: 'git commit failed',
        }),
        event({
          type: 'tool.result',
          toolUseId: 't2',
          isError: true,
          content: 'Failed',
          truncated: false,
          parentToolUseId: null,
        }),
      ],
    });
    await harness.fixture.whenStable();
    const states = [
      ...element.querySelectorAll('[data-testid="tool"] [data-tool-state]'),
    ].map((node) => node.textContent?.trim());
    expect(states).toEqual(['done by the app', 'failed']);
    const notes = [
      ...element.querySelectorAll('[data-testid="tool-by-app"]'),
    ].map((node) => node.textContent?.trim());
    expect(notes[0]).toBe(
      'Run by the app (autofix): Committed; pushed claude/x of acme/app at 1a2b3c4',
    );
  });

  it('lists running previews, embeds them and follows their state', async () => {
    const { harness, socket, element } = await open();
    const running = preview();
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session: sessionDto({ previews: [running] }),
      events: [
        event({
          type: 'tool.call',
          messageId: 'm',
          toolUseId: 't1',
          name: 'mcp__crm__expose_port',
          input: { port: 5173, name: 'Web app' },
          parentToolUseId: null,
        }),
        event({
          type: 'preview.exposed',
          toolUseId: 't1',
          preview: preview({ state: 'unreachable' }),
        }),
      ],
    });
    await harness.fixture.whenStable();
    const panel = element.querySelector(
      '[data-testid="session-previews"]',
    ) as HTMLElement;
    expect(panel.textContent).toContain('Web app');
    expect(
      panel.querySelector('[data-testid="previews-keep-running"]')?.textContent,
    ).toContain('does not go idle while it has previews');
    // The history's card shows the preview as it is now.
    const cards = [
      ...element.querySelectorAll('[data-testid="preview-card"]'),
    ].map((card) => card.getAttribute('data-state'));
    expect(cards).toEqual(['running', 'running']);

    (
      panel.querySelector('[data-testid="preview-embed"]') as HTMLButtonElement
    ).click();
    await harness.fixture.whenStable();
    expect(
      element
        .querySelector('[data-testid="preview-frame"]')
        ?.getAttribute('src'),
    ).toBe(running.url);

    // Stopped elsewhere: the frame goes, the cards say so.
    socket.receive({
      type: 'session.updated',
      session: sessionDto({ previews: [] }),
    });
    await harness.fixture.whenStable();
    expect(element.querySelector('[data-testid="preview-frame"]')).toBeNull();
    expect(element.textContent).toContain('This preview was stopped');
    expect(
      element.querySelector('[data-testid="session-previews"]'),
    ).toBeNull();
    expect(
      element
        .querySelector('[data-testid="preview-card"]')
        ?.getAttribute('data-state'),
    ).toBe('stopped');
  });

  it('shows the directories and the preparation, and holds messages back meanwhile', async () => {
    const { harness, socket, element, text } = await open();
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session: sessionDto({
        status: 'preparing',
        directories: [
          ...sessionDto().directories,
          {
            role: 'additional',
            kind: 'clone',
            path: '/workspace/sessions/reply-with-pong-abc123/acme/lib',
            state: 'pending',
            repository: {
              id: 'r2',
              fullName: 'acme/lib',
              local: false,
              github: false,
            },
            branch: 'claude/reply-with-pong-abc123',
            baseBranch: 'release',
            baseCommit: null,
            setupStatus: 'pending',
            pushedCommit: null,
            pushedAt: null,
          },
        ],
      }),
      events: [
        event({ type: 'user.message', id: 'u1', text: 'Reply with pong' }),
        event({
          type: 'prepare.progress',
          step: 'clone',
          state: 'succeeded',
          target: 'acme/app',
          path: '/workspace/sessions/reply-with-pong-abc123/acme/app',
          message: 'claude/reply-with-pong-abc123 from main at 0123456789ab',
        }),
        event({
          type: 'setup.result',
          repository: 'acme/app',
          path: '/workspace/sessions/reply-with-pong-abc123/acme/app',
          state: 'started',
          exitCode: null,
          signal: null,
          durationMs: null,
          message: null,
          outputTail: null,
        }),
        event({
          type: 'setup.output',
          repository: 'acme/app',
          text: 'added 3 packages',
        }),
      ],
    });
    await harness.fixture.whenStable();

    expect(text('status')).toBe('Preparing');
    expect(text('directories')).toContain('acme/app + acme/lib');
    const directories = [
      ...element.querySelectorAll('[data-testid="directory"]'),
    ].map((node) => words(node));
    expect(directories).toEqual([
      'acme/app working directory claude/reply-with-pong-abc123 from main at 0123456789ab /workspace/sessions/reply-with-pong-abc123/acme/app',
      'acme/lib additional pending setup pending claude/reply-with-pong-abc123 from release /workspace/sessions/reply-with-pong-abc123/acme/lib',
    ]);
    expect(text('progress')).toBe(
      'Cloned acme/app · claude/reply-with-pong-abc123 from main at 0123456789ab',
    );
    expect(words(element.querySelector('[data-testid="setup"]'))).toContain(
      'Setup acme/app running',
    );
    expect(text('setup')).toContain('added 3 packages');
    expect(element.textContent).toContain('Preparing the session');
    expect(
      (element.querySelector('[data-testid="send"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('shows when a session the usage limit stopped continues, and lets the user decide', async () => {
    const { harness, socket, element } = await open();
    const resumes = new Date();
    resumes.setHours(23, 58, 0, 0);
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session: sessionDto({
        status: 'waiting',
        waitingFor: 'limit',
        limitResumesAt: resumes.toISOString(),
        limitResetKnown: true,
      }),
      events: [
        event({ type: 'user.message', id: 'u1', text: 'Reply with pong' }),
        event({ type: 'message.queued', id: 'q1', text: 'Later' }),
      ],
    });
    await harness.fixture.whenStable();

    expect(words(element.querySelector('[data-testid="limit-wait"]'))).toMatch(
      /once it has reset \(around (\w+ )?23:58\)/,
    );
    expect(words(element.querySelector('[data-testid="queued-hint"]'))).toBe(
      '· sent when the usage limit resets',
    );
    const click = (testId: string) =>
      (
        element.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement
      ).click();
    click('limit-resume');
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'limit.resume',
      sessionId: 's1',
    });
    click('limit-cancel');
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'limit.cancel',
      sessionId: 's1',
    });

    socket.receive({
      type: 'session.updated',
      session: sessionDto({ status: 'running', waitingFor: null }),
    });
    await harness.fixture.whenStable();
    expect(element.querySelector('[data-testid="limit-wait"]')).toBeNull();
  });

  it('offers the decisions when a setup script failed and the first message waits', async () => {
    const { harness, socket, element } = await open();
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session: sessionDto({
        status: 'waiting',
        pendingMessage: 'Reply with pong',
      }),
      events: [
        event({ type: 'user.message', id: 'u1', text: 'Reply with pong' }),
      ],
    });
    await harness.fixture.whenStable();

    expect(words(element.querySelector('[data-testid="held-back"]'))).toContain(
      'A setup script failed',
    );
    expect(
      (element.querySelector('[data-testid="send"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    const click = (testId: string) =>
      (
        element.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement
      ).click();
    click('rerun-setup');
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'setup.rerun',
      sessionId: 's1',
    });
    click('send-pending');
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'pending.send',
      sessionId: 's1',
    });
    click('end-pending');
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'session.end',
      sessionId: 's1',
    });

    socket.receive({
      type: 'session.updated',
      session: sessionDto({ status: 'running', pendingMessage: null }),
    });
    await harness.fixture.whenStable();
    expect(element.querySelector('[data-testid="held-back"]')).toBeNull();
  });

  const history = (
    socket: FakeWebSocket,
    session = sessionDto(),
    events: SessionEvent[] = [],
  ) =>
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session,
      events,
    });
  const live = (socket: FakeWebSocket, input: SessionEvent) =>
    socket.receive({ type: 'session.event', sessionId: 's1', event: input });

  it('shows a pending approval as a card and sends the answer', async () => {
    const { harness, socket, element, text } = await open();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/models')
      .flush({
        models: [
          {
            value: 'haiku',
            label: 'Haiku 5',
            description: '',
            resolvedModel: 'claude-haiku-5',
          },
        ],
        source: 'claude-code',
        updatedAt: null,
      });
    const request = permissionRequest();
    history(
      socket,
      sessionDto({ status: 'waiting', waitingFor: 'permission' }),
      [request],
    );
    await harness.fixture.whenStable();
    expect(text('status')).toBe('Needs you');
    expect(text('resolved-model')).toBe('claude-haiku-5');
    // The row says it waits; the card in the dock is the only other place.
    expect(text('permission-line')).toBeUndefined();
    expect(
      element
        .querySelector('[data-testid="tool"] [data-tool-state]')
        ?.textContent?.trim(),
    ).toBe('needs approval');
    // A turn waits: it can be stopped, and messages are queued.
    expect(text('interrupt')).toBe('Stop');
    const card = element.querySelector('[data-testid="approvals"]');
    expect(card?.textContent).toContain('rm -r build');

    (card?.querySelector('[data-testid="allow"]') as HTMLButtonElement).click();
    await harness.fixture.whenStable();
    const answer = socket.sent.at(-1) as Record<string, unknown>;
    expect(answer).toMatchObject({
      type: 'permission.respond',
      sessionId: 's1',
      permissionRequestId: 'p1',
      decision: 'allow',
    });
    // No second answer while the first is on its way.
    expect(
      (card?.querySelector('[data-testid="allow"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    socket.receive({
      type: 'error',
      requestId: answer['requestId'] as string,
      message: 'Not connected',
    });
    await harness.fixture.whenStable();
    expect(
      (
        element.querySelector(
          '[data-testid="approvals"] [data-testid="allow"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    // Answered elsewhere: the card goes away for everyone.
    live(socket, {
      ...permissionResolvedEvent(),
      seq: 10,
    });
    live(socket, {
      type: 'session.status',
      status: 'running',
      waitingFor: null,
      seq: 11,
      at: null,
    });
    await harness.fixture.whenStable();
    expect(element.querySelector('[data-testid="approvals"]')).toBeNull();
    expect(text('permission-line')).toBe('Allowed for this session');
    expect(text('status')).toBe('Running');
  });

  it('shows answered questions as a card outside the group of tool calls', async () => {
    const { harness, socket, element, text } = await open();
    const questions = [
      {
        question: 'Which database?',
        header: 'Database',
        options: [
          { label: 'SQLite', description: 'One file', preview: null },
          { label: 'Postgres', description: 'A server', preview: null },
        ],
        multiSelect: false,
      },
      {
        question: 'Anything else?',
        header: '',
        options: [],
        multiSelect: false,
      },
    ];
    const call = (toolUseId: string, name: string) =>
      event({
        type: 'tool.call',
        messageId: 'm',
        toolUseId,
        name,
        input: { command: 'ls' },
        parentToolUseId: null,
      });
    history(socket, sessionDto({ status: 'waiting', waitingFor: null }), [
      call('t0', 'Bash'),
      call('t1', 'AskUserQuestion'),
      event(
        permissionRequest({
          toolUseId: 't1',
          toolName: 'AskUserQuestion',
          kind: 'question',
          questions,
        }),
      ),
      event(
        permissionResolved({
          toolUseId: 't1',
          answers: {
            'Which database?': 'SQLite',
            'Anything else?': 'Keep it small',
          },
        }),
      ),
      call('t2', 'Bash'),
    ]);
    await harness.fixture.whenStable();
    // The question breaks the run: no group, two rows and the card.
    expect(element.querySelector('[data-testid="tool-group"]')).toBeNull();
    expect(element.querySelectorAll('[data-testid="tool"]')).toHaveLength(2);
    expect(text('question-card')).toContain('Claude asked · Answered');
    const entries = [
      ...element.querySelectorAll('[data-testid="question"]'),
    ].map(words);
    expect(entries).toEqual([
      'Database Which database? SQLite One file',
      'Anything else? Keep it small',
    ]);
  });

  it('offers archiving instead of the input once the session has ended', async () => {
    const { harness, socket, element, text } = await open();
    history(socket, sessionDto({ status: 'finished', waitingFor: null }));
    await harness.fixture.whenStable();
    const composer = () => element.querySelector('app-message-composer');
    expect(text('archive-offer')).toContain('The session has ended.');
    expect(composer()).toBeNull();

    // Archive… opens the dialog to archive.
    (
      element.querySelector(
        '[data-testid="archive-offer-archive"]',
      ) as HTMLButtonElement
    ).click();
    await harness.fixture.whenStable();
    // It reads what the clones hold, as for archiving from the details.
    expect(
      TestBed.inject(HttpTestingController).match(
        (request) =>
          request.method === 'GET' && request.url.endsWith('/s1/cleanup'),
      ),
    ).toHaveLength(1);

    (
      element.querySelector(
        '[data-testid="archive-offer-continue"]',
      ) as HTMLButtonElement
    ).click();
    await harness.fixture.whenStable();
    expect(text('archive-offer')).toBeUndefined();
    expect(composer()).not.toBeNull();

    // Continued, then ended again: the offer comes back.
    live(socket, event({ type: 'session.status', status: 'running' }));
    live(socket, event({ type: 'session.status', status: 'finished' }));
    await harness.fixture.whenStable();
    expect(text('archive-offer')).toContain('The session has ended.');

    // Ending again with text in the input keeps the input.
    (
      element.querySelector(
        '[data-testid="archive-offer-continue"]',
      ) as HTMLButtonElement
    ).click();
    await harness.fixture.whenStable();
    const input = element.querySelector(
      '[data-testid="message-input"]',
    ) as HTMLTextAreaElement;
    input.value = 'Next step';
    input.dispatchEvent(new Event('input'));
    live(socket, event({ type: 'session.status', status: 'running' }));
    live(socket, event({ type: 'session.status', status: 'finished' }));
    await harness.fixture.whenStable();
    expect(text('archive-offer')).toBeUndefined();
    expect(composer()).not.toBeNull();

    // Archived: no offer.
    history(
      socket,
      sessionDto({
        status: 'finished',
        waitingFor: null,
        archivedAt: '2026-01-02T00:00:00Z',
      }),
    );
    await harness.fixture.whenStable();
    expect(text('archive-offer')).toBeUndefined();
  });

  it('offers only archiving when the ended session cannot be continued', async () => {
    const { harness, socket, element, text } = await open();
    const session = sessionDto({ status: 'finished', waitingFor: null });
    history(socket, {
      ...session,
      directories: session.directories.map((directory) => ({
        ...directory,
        state: 'removed' as const,
      })),
    });
    await harness.fixture.whenStable();
    expect(text('archive-offer')).toContain('cannot be continued');
    expect(
      element.querySelector('[data-testid="archive-offer-continue"]'),
    ).toBeNull();
    expect(element.querySelector('app-message-composer')).toBeNull();
  });

  it('shows an open draft pull request grey in the strip', async () => {
    const { harness, socket, element } = await open();
    history(
      socket,
      sessionDto({ pullRequests: [pullRequestDto({ draft: true })] }),
    );
    await harness.fixture.whenStable();
    const state = element.querySelector('[data-testid="strip-pr-state"]');
    expect(state?.textContent?.trim()).toBe('draft');
    expect(state?.classList).toContain('tone-draft');
  });

  it('shows the environment of the session in its details', async () => {
    const { harness, socket, text } = await open();
    history(socket, sessionDto({ environment: { id: 'e1', name: 'Staging' } }));
    await harness.fixture.whenStable();
    expect(text('session-environment')).toContain('Staging');
    expect(
      harness.fixture.nativeElement
        .querySelector('[data-testid="session-environment-link"]')
        ?.getAttribute('href'),
    ).toBe('/environments?id=e1');
    expect(
      harness.fixture.nativeElement.querySelector(
        '[data-testid="session-environment-setup"]',
      ),
    ).toBeNull();
  });

  it('shows a failed setup script of the environment', async () => {
    const { harness, socket, text } = await open();
    history(
      socket,
      sessionDto({
        environment: { id: 'e1', name: 'Staging', setupStatus: 'timed_out' },
      }),
    );
    await harness.fixture.whenStable();
    expect(text('session-environment-setup')).toContain('setup timed out');
  });

  it('confirms unarchiving with a toast', async () => {
    const { harness, socket, element, text } = await open();
    history(
      socket,
      sessionDto({
        status: 'finished',
        waitingFor: null,
        archivedAt: '2026-01-02T00:00:00Z',
      }),
    );
    await harness.fixture.whenStable();
    (
      element.querySelector(
        '[data-testid="unarchive-banner"]',
      ) as HTMLButtonElement
    ).click();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/sessions/s1/unarchive')
      .flush(sessionDto({ status: 'finished', waitingFor: null }));
    await harness.fixture.whenStable();
    expect(TestBed.inject(Toasts).all()).toMatchObject([
      { title: 'Session unarchived' },
    ]);
    expect(text('archived-banner')).toBeUndefined();
    // Unarchived to continue it: the input, not the archive offer.
    expect(text('archive-offer')).toBeUndefined();
    expect(element.querySelector('app-message-composer')).not.toBeNull();
  });

  it('makes no offer for failed sessions', async () => {
    const { harness, socket, text } = await open();
    history(socket, sessionDto({ status: 'failed', waitingFor: null }));
    await harness.fixture.whenStable();
    expect(text('archive-offer')).toBeUndefined();
  });

  it('keeps the input of an ended session with text in it, also emptied', async () => {
    const { harness, socket, element, text } = await open(
      '/sessions/s1?mention=%40src%2Fmain.ts',
    );
    history(socket, sessionDto({ status: 'finished', waitingFor: null }));
    await harness.fixture.whenStable();
    expect(text('archive-offer')).toBeUndefined();
    const input = element.querySelector(
      '[data-testid="message-input"]',
    ) as HTMLTextAreaElement;
    input.value = '';
    input.dispatchEvent(new Event('input'));
    await harness.fixture.whenStable();
    expect(text('archive-offer')).toBeUndefined();
    expect(element.querySelector('[data-testid="message-input"]')).toBe(input);
  });

  it('takes a withdrawn message of an ended session back into the input', async () => {
    const { harness, socket, element, text } = await open();
    history(socket, sessionDto({ status: 'finished', waitingFor: null }), [
      event({ type: 'message.queued', id: 'q1', text: 'Stopped one' }),
      event({
        type: 'message.dequeued',
        id: 'q1',
        outcome: 'withdrawn',
        reason: 'The session was ended.',
      }),
    ]);
    await harness.fixture.whenStable();
    expect(text('archive-offer')).toContain('The session has ended.');
    (
      element.querySelector(
        '[data-testid="edit-withdrawn"]',
      ) as HTMLButtonElement
    ).click();
    await harness.fixture.whenStable();
    expect(text('archive-offer')).toBeUndefined();
    expect(
      (
        element.querySelector(
          '[data-testid="message-input"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe('Stopped one');
  });

  it('shows queued messages, removes them and offers withdrawn ones again', async () => {
    const { harness, socket, element, text } = await open();
    history(socket, sessionDto({ status: 'running', waitingFor: null }), [
      event({ type: 'message.queued', id: 'q1', text: 'Also this' }),
      event({ type: 'message.queued', id: 'q2', text: 'Stopped one' }),
      event({
        type: 'message.dequeued',
        id: 'q2',
        outcome: 'withdrawn',
        reason: 'The turn was stopped.',
      }),
    ]);
    await harness.fixture.whenStable();
    expect(
      element.querySelector('[data-testid="queued"]')?.textContent,
    ).toContain('Also this');
    (
      element.querySelector('[data-testid="unqueue"]') as HTMLButtonElement
    ).click();
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'message.unqueue',
      sessionId: 's1',
      messageId: 'q1',
    });
    (
      element.querySelector(
        '[data-testid="send-queued-message"]',
      ) as HTMLButtonElement
    ).click();
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'queue.send',
      sessionId: 's1',
      messageId: 'q1',
    });
    await harness.fixture.whenStable();
    expect(text('queued-hint')).toBe('· sending now…');
    // The only queued message is being sent already.
    expect(
      (
        element.querySelector(
          '[data-testid="send-queued"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      element.querySelector('[data-testid="withdrawn"]')?.textContent,
    ).toContain('Not sent: The turn was stopped.');
    (
      element.querySelector(
        '[data-testid="edit-withdrawn"]',
      ) as HTMLButtonElement
    ).click();
    await harness.fixture.whenStable();
    expect(
      (
        element.querySelector(
          '[data-testid="message-input"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe('Stopped one');
  });

  it('sends all queued messages right away', async () => {
    const { harness, socket, element, text } = await open();
    history(socket, sessionDto({ status: 'running', waitingFor: null }), [
      event({ type: 'message.queued', id: 'q1', text: 'One' }),
      event({ type: 'message.queued', id: 'q2', text: 'Two' }),
    ]);
    await harness.fixture.whenStable();
    expect(text('queued-hint')).toBe('· sent when the turn ends');
    (
      element.querySelector('[data-testid="send-queued"]') as HTMLButtonElement
    ).click();
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'queue.send',
      sessionId: 's1',
    });
    expect(socket.sent.at(-1)).not.toHaveProperty('messageId');
    await harness.fixture.whenStable();
    expect(text('queued-hint')).toBe('· sending now…');
    const buttons = element.querySelectorAll(
      '[data-testid="send-queued-message"]',
    );
    expect(
      [...buttons].every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
    // Refused (e.g. while Claude Code restarts): they wait again.
    socket.receive({
      type: 'error',
      requestId: (socket.sent.at(-1) as { requestId: string }).requestId,
      message: 'Claude Code is being restarted',
    });
    await harness.fixture.whenStable();
    expect(text('queued-hint')).toBe('· sent when the turn ends');
    expect(text('error')).toBe('Claude Code is being restarted');
    expect(
      (
        element.querySelector(
          '[data-testid="send-queued"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it('shows the images of messages', async () => {
    const { harness, socket, element } = await open();
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session: sessionDto(),
      events: [
        event({
          type: 'user.message',
          id: 'u1',
          text: 'What is this?',
          attachments: [
            { id: 'a1', name: 'shot.png', mediaType: 'image/png', size: 9 },
          ],
        }),
      ],
    });
    await harness.fixture.whenStable();
    const message = element.querySelector('.user-message');
    expect(message?.textContent).toBe('What is this?');
    const image = message?.querySelector(
      '[data-testid="message-image"] img',
    ) as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('/api/attachments/a1');
    expect(image.alt).toBe('shot.png');
  });

  it('marks messages the app sent (PR automation) as such', async () => {
    const { harness, socket, element } = await open();
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session: sessionDto(),
      events: [
        event({ type: 'user.message', id: 'u1', text: 'Mine' }),
        event({
          type: 'user.message',
          id: 'u2',
          text: 'Autofix, attempt 1 of 3',
          origin: 'app',
        }),
      ],
    });
    await harness.fixture.whenStable();
    const messages = [...element.querySelectorAll('.user-message')];
    expect(messages[0].getAttribute('data-origin')).not.toBe('app');
    expect(messages[0].textContent).toBe('Mine');
    expect(messages[1].getAttribute('data-origin')).toBe('app');
    expect(
      messages[1].querySelector('[data-testid="app-message-label"]')
        ?.textContent,
    ).toBe('Sent by the app · PR automation');
  });

  it('shows references of messages as chips and what Claude got', async () => {
    const { harness, socket, element } = await open();
    const http = TestBed.inject(HttpTestingController);
    socket.receive({
      type: 'session.history',
      logId: LOG,
      complete: true,
      drafts: [],
      session: sessionDto(),
      events: [
        event({
          type: 'user.message',
          id: 'u1',
          text: 'Fix #12 please',
          references: [
            {
              token: '#12',
              repository: 'acme/app',
              number: 12,
              comments: true,
              diff: false,
              status: 'resolved',
              kind: 'issue',
              title: 'Login fails',
              state: 'open',
              draft: false,
              url: 'https://github.com/acme/app/issues/12',
              error: null,
              notes: ['Only the latest 50 of 80 comments were included'],
            },
          ],
          contextLength: 2048,
        }),
      ],
    });
    await harness.fixture.whenStable();
    const message = element.querySelector('.user-message');
    expect(words(message)).toBe('Fix #12 Login fails +comments please');
    const context = element.querySelector(
      '[data-testid="message-context"]',
    ) as HTMLDetailsElement;
    expect(words(context.querySelector('summary'))).toBe(
      'GitHub context for Claude (2.0k characters)',
    );
    context.open = true;
    context.dispatchEvent(new Event('toggle'));
    http
      .expectOne('/api/sessions/s1/messages/u1/context')
      .flush({ messageId: 'u1', context: 'The app attached…', references: [] });
    await harness.fixture.whenStable();
    expect(context.querySelector('pre')?.textContent).toBe('The app attached…');
  });

  it('switches model and mode and shows the task list', async () => {
    const { harness, socket, element, text } = await open();
    history(socket, sessionDto({ status: 'waiting' }), [
      event({
        type: 'tool.call',
        messageId: 'm',
        toolUseId: 't',
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Read', status: 'completed', activeForm: 'Reading' },
            { content: 'Test', status: 'in_progress', activeForm: 'Testing' },
          ],
        },
        parentToolUseId: null,
      }),
    ]);
    await harness.fixture.whenStable();
    expect(text('todos')).toContain('Tasks 1/2');
    expect(text('todos')).toContain('Testing');
    expect(text('context-unknown')).toContain('known after');

    const view = harness.routeDebugElement?.componentInstance as {
      configure(change: { model?: string; permissionMode?: string }): void;
    };
    view.configure({ model: '' });
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'session.update',
      sessionId: 's1',
      model: null,
    });
    view.configure({ permissionMode: 'plan' });
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'session.update',
      permissionMode: 'plan',
    });
    expect(socket.sent.at(-1)).not.toHaveProperty('model');
  });

  it('shows the permission mode in effect when it is not the chosen one', async () => {
    const { harness, socket, element, text } = await open();
    history(
      socket,
      sessionDto({
        status: 'running',
        waitingFor: null,
        permissionMode: 'auto',
        permissionModeOverride: { mode: 'default', reason: 'auto_unavailable' },
      }),
    );
    await harness.fixture.whenStable();
    expect(text('strip-settings')).toContain('Ask (auto unavailable)');
    expect(text('mode-override')).toContain('In effect: Ask.');
    expect(text('mode-override')).toContain('not available');

    socket.receive({
      type: 'session.updated',
      session: sessionDto({
        status: 'waiting',
        permissionMode: 'auto',
        permissionModeOverride: null,
      }),
    });
    await harness.fixture.whenStable();
    expect(text('strip-settings')).toContain('Auto');
    expect(text('strip-settings')).not.toContain('(');
    expect(element.querySelector('[data-testid="mode-override"]')).toBeNull();
  });

  it('marks bypassing permissions as dangerous, unless Claude Code refused it', async () => {
    const { harness, socket, element, text } = await open();
    history(
      socket,
      sessionDto({
        status: 'waiting',
        permissionMode: 'bypassPermissions',
        permissionModeOverride: null,
      }),
    );
    await harness.fixture.whenStable();
    const chip = () =>
      element.querySelector('[data-testid="strip-settings"]') as HTMLElement;
    expect(text('strip-settings')).toContain('Bypass (dangerous)');
    expect(chip().classList).toContain('tone-attention');
    const hint = element.querySelector('[data-testid="mode-hint"]');
    expect(hint?.classList).toContain('text-tertiary');
    expect(hint?.textContent).toContain('without asking');

    socket.receive({
      type: 'session.updated',
      session: sessionDto({
        status: 'running',
        waitingFor: null,
        permissionMode: 'bypassPermissions',
        permissionModeOverride: {
          mode: 'default',
          reason: 'bypass_unavailable',
        },
      }),
    });
    await harness.fixture.whenStable();
    expect(text('strip-settings')).toContain('Ask (bypass unavailable)');
    expect(chip().classList).not.toContain('tone-attention');
  });
});

function permissionResolvedEvent(): SessionEvent {
  return {
    type: 'permission.resolved',
    seq: 0,
    at: null,
    requestId: 'p1',
    toolUseId: 't1',
    decision: 'allow',
    scope: 'session',
    cause: 'user',
    message: null,
    answers: null,
    mode: null,
    sessionAllow: { rules: ['Bash(rm:*)'], directories: [], mode: null },
  };
}
