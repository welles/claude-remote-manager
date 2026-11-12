import type {
  SessionEvent,
  SessionEventInput,
} from '@claude-remote-manager/shared-types';
import {
  applyDraft,
  applyEvent,
  buildConversation,
  progressText,
  toolSummary,
  type ConversationItem,
} from './conversation';

let seq = 0;
const event = (input: SessionEventInput): SessionEvent =>
  ({ ...input, seq: ++seq, at: '2026-01-01T00:00:00Z' }) as SessionEvent;

const usage = {
  inputTokens: 1,
  outputTokens: 2,
  cacheCreationInputTokens: 3,
  cacheReadInputTokens: 4,
  costUsd: 0.01,
};

describe('conversation', () => {
  it('streams text and replaces it with the complete block', () => {
    let items = buildConversation([
      event({ type: 'user.message', id: 'u1', text: 'Hi' }),
      event({
        type: 'assistant.delta',
        messageId: 'm1',
        blockIndex: 0,
        text: 'Hel',
        parentToolUseId: null,
      }),
    ]);
    items = applyEvent(
      items,
      event({
        type: 'assistant.delta',
        messageId: 'm1',
        blockIndex: 0,
        text: 'lo',
        parentToolUseId: null,
      }),
    );
    expect(items).toEqual([
      { kind: 'user', key: 'user:u1', text: 'Hi' },
      {
        kind: 'assistant',
        key: 'text:m1:0',
        text: 'Hello',
        streaming: true,
        nested: false,
      },
    ]);

    items = applyEvent(
      items,
      event({
        type: 'assistant.text',
        messageId: 'm1',
        blockIndex: 0,
        text: 'Hello!',
        parentToolUseId: null,
      }),
    );
    expect(items[1]).toEqual({
      kind: 'assistant',
      key: 'text:m1:0',
      text: 'Hello!',
      streaming: false,
      nested: false,
    });
    expect(items).toHaveLength(2);
  });

  it('adds text blocks that were not streamed', () => {
    const items = buildConversation([
      event({
        type: 'assistant.text',
        messageId: 'm1',
        blockIndex: null,
        text: 'a',
        parentToolUseId: null,
      }),
      event({
        type: 'assistant.text',
        messageId: 'm1',
        blockIndex: null,
        text: 'b',
        parentToolUseId: 'task',
      }),
    ]);
    expect(
      items.map(
        (item) => item.kind === 'assistant' && [item.text, item.nested],
      ),
    ).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  it('combines tool calls with their results and denials', () => {
    const items = buildConversation([
      event({
        type: 'tool.call',
        messageId: 'm',
        toolUseId: 't1',
        name: 'Bash',
        input: { command: 'ls -la' },
        parentToolUseId: null,
      }),
      event({
        type: 'tool.result',
        toolUseId: 't1',
        isError: false,
        content: 'a.txt',
        truncated: false,
        parentToolUseId: null,
      }),
      event({
        type: 'permission.denied',
        toolUseId: 't2',
        toolName: 'Write',
        input: { file_path: '/x' },
        message: 'Not yet',
        reason: 'no_approval_ui',
      }),
      event({
        type: 'tool.call',
        messageId: 'm',
        toolUseId: 't2',
        name: 'Write',
        input: { file_path: '/x' },
        parentToolUseId: null,
      }),
      event({
        type: 'tool.result',
        toolUseId: 'unknown',
        isError: true,
        content: '',
        truncated: false,
        parentToolUseId: null,
      }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'tool',
        key: 'tool:t1',
        name: 'Bash',
        summary: 'ls -la',
        result: { isError: false, content: 'a.txt', truncated: false },
        denied: null,
      }),
      expect.objectContaining({
        kind: 'tool',
        key: 'tool:t2',
        summary: '/x',
        denied: 'Not yet',
        result: null,
      }),
    ]);
  });

  it('shows turn results, notices and errors, but not status changes', () => {
    const items = buildConversation([
      event({ type: 'session.status', status: 'running' }),
      event({ type: 'notice', level: 'warning', text: 'Retrying' }),
      event({ type: 'error', message: 'Boom' }),
      event({
        type: 'turn.result',
        subtype: 'success',
        isError: false,
        interrupted: true,
        durationMs: 1200,
        numTurns: 1,
        usage,
        errors: [],
      }),
      event({
        type: 'context.usage',
        context: {
          model: 'm',
          usedTokens: 1,
          maxTokens: 2,
          percentage: 50,
          updatedAt: '',
        },
      }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(['notice', 'error', 'turn']);
    expect(items[2]).toMatchObject({
      interrupted: true,
      durationMs: 1200,
      usage,
    });
  });

  it('replaces the text of a streaming block with a draft', () => {
    let items = buildConversation([
      event({
        type: 'assistant.delta',
        messageId: 'm1',
        blockIndex: 0,
        text: 'He',
        parentToolUseId: null,
      }),
    ]);
    items = applyDraft(items, {
      messageId: 'm1',
      blockIndex: 0,
      text: 'Hello',
      parentToolUseId: null,
    });
    items = applyDraft(items, {
      messageId: 'm1',
      blockIndex: 1,
      text: 'More',
      parentToolUseId: 'task',
    });
    expect(items).toEqual([
      {
        kind: 'assistant',
        key: 'text:m1:0',
        text: 'Hello',
        streaming: true,
        nested: false,
      },
      {
        kind: 'assistant',
        key: 'text:m1:1',
        text: 'More',
        streaming: true,
        nested: true,
      },
    ]);
  });

  it('returns the same array when nothing changes', () => {
    const items = buildConversation([]);
    expect(
      applyEvent(items, event({ type: 'session.status', status: 'waiting' })),
    ).toBe(items);
  });
});

describe('toolSummary', () => {
  it('prefers the meaningful field and shortens long input', () => {
    expect(toolSummary('Read', { file_path: '/a/b.ts', limit: 3 })).toBe(
      '/a/b.ts',
    );
    expect(toolSummary('X', { a: 1 })).toBe('{"a":1}');
    expect(toolSummary('X', null)).toBe('');
    const long = toolSummary('Bash', { command: 'echo '.repeat(50) });
    expect(long.length).toBe(120);
    expect(long.endsWith('…')).toBe(true);
  });

  it('shows preparation steps, updating each step in place', () => {
    const progress = (
      step: 'fetch' | 'worktree' | 'rollback' | 'done',
      state: 'started' | 'succeeded' | 'failed',
      target: string | null,
      message: string | null = null,
    ) =>
      event({
        type: 'prepare.progress',
        step,
        state,
        target,
        path: target ? `/w/${target}` : null,
        message,
      });
    const items = buildConversation([
      progress('fetch', 'started', 'acme/app'),
      progress('fetch', 'started', 'acme/lib'),
      progress('fetch', 'succeeded', 'acme/app', 'Default branch main'),
      progress(
        'worktree',
        'succeeded',
        'acme/app',
        'claude/x from main at abc',
      ),
      progress(
        'fetch',
        'failed',
        'acme/lib',
        'Could not update acme/lib: offline',
      ),
      progress('rollback', 'succeeded', 'acme/app', 'Removed'),
      progress('done', 'succeeded', null),
    ]);

    expect(
      items.map((item) =>
        progressText(item as Extract<ConversationItem, { kind: 'progress' }>),
      ),
    ).toEqual([
      'Updated acme/app · Default branch main',
      'Could not update acme/lib: offline',
      'Worktree of acme/app · claude/x from main at abc',
      'Removed acme/app again',
      'Ready. The message went to Claude.',
    ]);
  });

  it('collects setup output under its result', () => {
    const result = (
      state: 'started' | 'failed',
      details: Record<string, unknown> = {},
    ) =>
      event({
        type: 'setup.result',
        repository: 'acme/app',
        path: '/w/app',
        state,
        exitCode: null,
        signal: null,
        durationMs: null,
        message: null,
        outputTail: null,
        ...details,
      } as SessionEventInput);
    const items = buildConversation([
      result('started'),
      event({ type: 'setup.output', repository: 'acme/app', text: 'npm ' }),
      event({ type: 'setup.output', repository: 'acme/app', text: 'ERR!\n' }),
      result('failed', { exitCode: 1, durationMs: 1200 }),
    ]);

    expect(items).toEqual([
      {
        kind: 'setup',
        key: 'setup:acme/app',
        repository: 'acme/app',
        path: '/w/app',
        state: 'failed',
        output: 'npm ERR!\n',
        exitCode: 1,
        durationMs: 1200,
        message: null,
        outputTail: null,
      },
    ]);
  });
});
