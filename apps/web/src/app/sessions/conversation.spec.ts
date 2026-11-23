import type {
  SessionEvent,
  SessionEventInput,
} from '@claude-remote-manager/shared-types';
import {
  applyDraft,
  applyEvent,
  buildConversation,
  pendingRequests,
  progressText,
  questionCard,
  resolutionText,
  toolSummary,
  type ConversationItem,
} from './conversation';
import { groupPreparation } from './preparation';
import { fileDiff } from '../diffs/testing/file-diffs';
import { shownFile } from '../shown-files/testing/shown-file';
import { preview } from '../previews/testing/preview';
import {
  permissionRequest,
  permissionResolved,
} from './testing/permission-events';

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
      {
        kind: 'user',
        key: 'user:u1',
        id: 'u1',
        text: 'Hi',
        attachments: [],
        references: [],
        contextLength: null,
        origin: 'user',
      },
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

  it('attaches file diffs to their tool call', () => {
    const diff = fileDiff();
    const items = buildConversation([
      event({
        type: 'tool.call',
        messageId: 'm',
        toolUseId: 't1',
        name: 'Edit',
        input: { file_path: diff.path },
        parentToolUseId: null,
      }),
      event({
        type: 'tool.diff',
        toolUseId: 't1',
        diff,
        source: 'result',
        parentToolUseId: null,
      }),
      // A diff of an unknown call changes nothing.
      event({
        type: 'tool.diff',
        toolUseId: 'other',
        diff,
        source: 'input',
        parentToolUseId: null,
      }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        key: 'tool:t1',
        diff: { diff, source: 'result' },
      }),
    ]);
    // A later call event (e.g. replayed) keeps the diff.
    const again = applyEvent(
      items,
      event({
        type: 'tool.call',
        messageId: 'm',
        toolUseId: 't1',
        name: 'Edit',
        input: { file_path: diff.path },
        parentToolUseId: null,
      }),
    );
    expect(again[0]).toMatchObject({ diff: { source: 'result' } });
  });

  it('puts shown files on their tool call, or on their own', () => {
    const file = shownFile();
    const items = buildConversation([
      event({
        type: 'tool.call',
        messageId: 'm',
        toolUseId: 't1',
        name: 'mcp__crm__show_file',
        input: { path: 'report.md' },
        parentToolUseId: null,
      }),
      event({ type: 'file.shown', toolUseId: 't1', file }),
      // Repeated: once.
      event({ type: 'file.shown', toolUseId: 't1', file }),
      event({
        type: 'file.shown',
        toolUseId: null,
        file: shownFile({ id: 'f2' }),
      }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ key: 'tool:t1', shown: [file] }),
      { kind: 'file', key: 'file:f2', file: shownFile({ id: 'f2' }) },
    ]);
  });

  it('puts exposed previews on their tool call and notes stopped ones', () => {
    const exposed = preview();
    const items = buildConversation([
      event({
        type: 'tool.call',
        messageId: 'm',
        toolUseId: 't1',
        name: 'mcp__crm__expose_port',
        input: { port: 5173, name: 'Web app' },
        parentToolUseId: null,
      }),
      event({ type: 'preview.exposed', toolUseId: 't1', preview: exposed }),
      event({ type: 'preview.exposed', toolUseId: 't1', preview: exposed }),
      event({
        type: 'preview.exposed',
        toolUseId: null,
        preview: preview({ id: 'p2' }),
      }),
      event({
        type: 'preview.stopped',
        toolUseId: null,
        previewId: exposed.id,
        port: 5173,
        name: 'Web app',
        by: 'user',
      }),
      event({
        type: 'preview.stopped',
        toolUseId: null,
        previewId: 'p2',
        port: 5173,
        name: 'Web app',
        by: 'session_end',
      }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        key: 'tool:t1',
        summary: 'port 5173 · Web app',
        previews: [exposed],
      }),
      expect.objectContaining({
        kind: 'preview',
        preview: preview({ id: 'p2' }),
      }),
      expect.objectContaining({
        kind: 'notice',
        text: 'Preview "Web app" (port 5173) stopped by you',
      }),
      expect.objectContaining({
        kind: 'notice',
        text: 'Preview "Web app" (port 5173) stopped because the session ended',
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
      step: 'fetch' | 'clone' | 'scratch' | 'rollback' | 'done',
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
      progress('clone', 'succeeded', 'acme/app', 'claude/x from main at abc'),
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
      'Cloned acme/app · claude/x from main at abc',
      'Removed acme/app again',
      'Ready. The message went to Claude.',
    ]);
  });

  it('shows each addition of a repository as a row of its own', () => {
    const step = (
      kind: 'add' | 'fetch' | 'clone' | 'done',
      state: 'started' | 'succeeded' | 'failed',
      target: string | null,
      addition?: string,
      message: string | null = null,
    ) =>
      event({
        type: 'prepare.progress',
        step: kind,
        state,
        target,
        path: null,
        message,
        ...(addition ? { addition } : {}),
      });
    const setup = (state: 'started' | 'failed', addition: string) =>
      event({
        type: 'setup.result',
        repository: 'acme/lib',
        path: '/w/lib',
        state,
        exitCode: state === 'failed' ? 1 : null,
        signal: null,
        durationMs: null,
        message: null,
        outputTail: null,
        addition,
      });
    const shown = groupPreparation(
      buildConversation([
        step('fetch', 'succeeded', 'acme/app'),
        step('done', 'succeeded', null),
        event({ type: 'user.message', id: 'u1', text: 'Hi' }),
        step('add', 'started', 'acme/lib', 'a1', 'Added by you'),
        step('fetch', 'succeeded', 'acme/lib', 'a1'),
        step('clone', 'succeeded', 'acme/lib', 'a1'),
        setup('started', 'a1'),
        setup('failed', 'a1'),
        step('add', 'failed', 'acme/lib', 'a1', 'The setup script failed: …'),
        // The retry is a row of its own, after the first.
        step('add', 'started', 'acme/lib', 'a2', 'Added by you'),
        setup('started', 'a2'),
        step('add', 'succeeded', 'acme/lib', 'a2', 'claude/x from main'),
      ]),
    );
    const rows = shown.flatMap((item) =>
      item.kind === 'prep'
        ? [`${item.label}|${item.summary}|${item.failed}|${item.steps.length}`]
        : [item.kind],
    );
    expect(rows).toEqual([
      'Prepare|Ready. The message went to Claude.|false|2',
      'user',
      // Later states of a step replace it in place.
      'Add repository|The setup script failed: …|true|4',
      'Add repository|Added acme/lib · claude/x from main|false|2',
    ]);
  });

  it('summarizes add_repository calls', () => {
    expect(
      toolSummary('mcp__crm__add_repository', {
        repository: 'acme/lib',
        base_branch: 'dev',
        reason: 'r',
      }),
    ).toBe('acme/lib from dev');
    expect(
      toolSummary('mcp__crm__add_repository', {
        url: 'https://example.com/a/b.git',
        reason: 'r',
      }),
    ).toBe('https://example.com/a/b.git');
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
        addition: null,
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

describe('approval requests, queue and settings in the conversation', () => {
  it('attaches requests to their tool call, also when they come first', () => {
    const request = permissionRequest();
    let items = buildConversation([request]);
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'tool',
        key: 'tool:t1',
        name: 'Bash',
        permission: { request, resolved: null },
      }),
    ]);
    expect(pendingRequests(items)).toEqual([request]);
    items = applyEvent(
      items,
      event({
        type: 'tool.call',
        messageId: 'm1',
        toolUseId: 't1',
        name: 'Bash',
        input: { command: 'rm -r build' },
        parentToolUseId: null,
      }),
    );
    expect(items).toHaveLength(1);
    const resolved = permissionResolved({ decision: 'deny', message: 'No' });
    items = applyEvent(items, resolved);
    const tool = items[0];
    expect(tool.kind === 'tool' && tool.permission).toEqual({
      request,
      resolved,
    });
    expect(pendingRequests(items)).toEqual([]);
  });

  it('describes how requests were decided', () => {
    const tool = permissionRequest();
    const text = (
      request: typeof tool,
      resolved: Parameters<typeof permissionResolved>[0] | null,
    ) =>
      resolutionText({
        request,
        resolved: resolved ? permissionResolved(resolved) : null,
      });
    expect(text(tool, null)).toBe('Waiting for your approval');
    expect(text(tool, {})).toBe('Allowed once');
    expect(text(tool, { scope: 'session' })).toBe('Allowed for this session');
    expect(text(tool, { decision: 'deny', message: 'Not now' })).toBe(
      'Denied: Not now',
    );
    expect(text(tool, { decision: 'deny', cause: 'interrupted' })).toBe(
      'Cancelled: the turn was stopped',
    );
    const plan = permissionRequest({ kind: 'plan', toolName: 'ExitPlanMode' });
    expect(text(plan, { mode: 'acceptEdits' })).toBe(
      'Plan approved, continuing in mode Accept edits',
    );
    expect(text(plan, { decision: 'deny', message: 'More tests' })).toBe(
      'Kept planning: More tests',
    );
    const question = permissionRequest({ kind: 'question' });
    expect(text(question, null)).toBe('Waiting for your answer');
    expect(text(question, { answers: { a: 'b' } })).toBe('Answered');
  });

  it('makes a card of a question with the answers given', () => {
    const questions = [
      {
        question: 'Which?',
        header: 'Pick',
        options: [{ label: 'A', description: 'The first', preview: null }],
        multiSelect: false,
      },
      { question: 'Why?', header: '', options: [], multiSelect: false },
    ];
    const request = permissionRequest({
      toolName: 'AskUserQuestion',
      kind: 'question',
      questions,
    });
    const card = (resolved: ReturnType<typeof permissionResolved> | null) =>
      questionCard(
        buildConversation([
          request,
          ...(resolved ? [resolved] : []),
        ])[0] as ConversationItem,
      );
    expect(card(null)).toEqual({
      state: 'Waiting for your answer',
      tone: 'open',
      questions: [
        { header: 'Pick', question: 'Which?', answer: null, description: null },
        { header: '', question: 'Why?', answer: null, description: null },
      ],
      other: [],
      problem: null,
    });
    expect(
      card(permissionResolved({ answers: { 'Which?': 'A', 'Why?': ' Own ' } })),
    ).toMatchObject({
      tone: 'answered',
      questions: [
        { answer: 'A', description: 'The first' },
        { answer: 'Own', description: null },
      ],
    });
    expect(
      card(permissionResolved({ decision: 'deny', message: 'Later' })),
    ).toMatchObject({ state: 'Not answered: Later', tone: 'unanswered' });
    expect(
      card(permissionResolved({ decision: 'deny', cause: 'interrupted' })),
    ).toMatchObject({
      state: 'Cancelled: the turn was stopped',
      tone: 'unanswered',
    });
    // Answers to no question of the request still show.
    expect(
      card(permissionResolved({ answers: { 'Which?': 'A', Other: 'B' } }))
        ?.other,
    ).toEqual([{ question: 'Other', answer: 'B' }]);
    // Multi-select: the explanation of each chosen option.
    const multi = permissionRequest({
      toolName: 'AskUserQuestion',
      kind: 'question',
      questions: [
        {
          question: 'Which?',
          header: '',
          options: [
            { label: 'A', description: 'First', preview: null },
            { label: 'B', description: 'Second', preview: null },
          ],
          multiSelect: true,
        },
      ],
    });
    expect(
      questionCard(
        buildConversation([
          multi,
          permissionResolved({ answers: { 'Which?': 'A, B' } }),
        ])[0],
      )?.questions[0],
    ).toMatchObject({ answer: 'A, B', description: 'First · Second' });
    // Other tool calls are no cards.
    expect(
      questionCard(buildConversation([permissionRequest()])[0]),
    ).toBeNull();
  });

  it('shows queued messages until they are sent, removed or withdrawn', () => {
    let items = buildConversation([
      event({ type: 'message.queued', id: 'q1', text: 'Also this' }),
      event({ type: 'message.queued', id: 'q2', text: 'And that' }),
      event({ type: 'message.queued', id: 'q3', text: 'Never mind' }),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      'queued',
      'queued',
      'queued',
    ]);
    items = [
      event({
        type: 'message.dequeued',
        id: 'q1',
        outcome: 'sent',
        reason: null,
      }),
      event({ type: 'user.message', id: 'q1', text: 'Also this' }),
      event({
        type: 'message.dequeued',
        id: 'q2',
        outcome: 'withdrawn',
        reason: 'The turn was stopped.',
      }),
      event({
        type: 'message.dequeued',
        id: 'q3',
        outcome: 'removed',
        reason: null,
      }),
    ].reduce(applyEvent, items);
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'queued',
        id: 'q2',
        state: 'withdrawn',
        reason: 'The turn was stopped.',
      }),
      expect.objectContaining({ kind: 'user', text: 'Also this' }),
    ]);
  });

  it('notes model and mode changes', () => {
    const items = buildConversation([
      event({ type: 'settings.changed', model: 'sonnet', cause: 'user' }),
      event({
        type: 'settings.changed',
        permissionMode: 'acceptEdits',
        cause: 'plan',
      }),
      event({ type: 'settings.changed', model: null, cause: 'user' }),
      event({
        type: 'settings.changed',
        permissionMode: 'plan',
        cause: 'claude',
      }),
    ]);
    expect(
      items.map((item) => (item.kind === 'settings' ? item.text : '')),
    ).toEqual([
      'Model: sonnet',
      'Mode: Accept edits (plan approved)',
      'Model: default',
      'Mode: Plan (changed by Claude)',
    ]);
  });

  it('notes title changes instead of the tool call that made them', () => {
    const items = buildConversation([
      event({
        type: 'tool.call',
        messageId: 'm',
        toolUseId: 't1',
        name: 'mcp__crm__set_session_title',
        input: { title: 'Login fails with SSO' },
        parentToolUseId: null,
      }),
      event({
        type: 'tool.result',
        toolUseId: 't1',
        isError: false,
        content: 'The session is titled "Login fails with SSO".',
        truncated: false,
        parentToolUseId: null,
      }),
      event({
        type: 'settings.changed',
        title: 'Login fails with SSO',
        cause: 'claude',
      }),
      event({ type: 'settings.changed', title: 'Mine', cause: 'user' }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(['settings', 'settings']);
    expect(
      items.map((item) => (item.kind === 'settings' ? item.text : '')),
    ).toEqual([
      'Title: Login fails with SSO (changed by Claude)',
      'Title: Mine',
    ]);

    // Should it ever be denied, that still shows.
    const denied = buildConversation([
      event({
        type: 'permission.denied',
        toolUseId: 't2',
        toolName: 'mcp__crm__set_session_title',
        input: { title: 'x' },
        message: 'Denied by a rule',
        reason: 'rule',
      }),
    ]);
    expect(denied.map((item) => item.kind)).toEqual(['tool']);
  });

  it('leaves out the waiting state Claude sets: the status shows it', () => {
    const items = buildConversation([
      event({
        type: 'tool.call',
        messageId: 'm',
        toolUseId: 't1',
        name: 'mcp__crm__set_waiting_state',
        input: { waiting_on: 'work', reason: 'CI of PR #12' },
        parentToolUseId: null,
      }),
      event({
        type: 'tool.result',
        toolUseId: 't1',
        isError: false,
        content: 'After this turn…',
        truncated: false,
        parentToolUseId: null,
      }),
    ]);
    expect(items).toEqual([]);
  });
});

describe('tool summaries', () => {
  it('summarizes questions, plans and tasks readably', () => {
    expect(
      toolSummary('AskUserQuestion', {
        questions: [{ question: 'Which?' }, { question: 'When?' }],
      }),
    ).toBe('Which? · When?');
    expect(toolSummary('ExitPlanMode', { plan: '# Long' })).toBe(
      'Plan for approval',
    );
    expect(
      toolSummary('TaskCreate', { subject: 'Write tests', description: 'x' }),
    ).toBe('Write tests');
    expect(
      toolSummary('TaskUpdate', { taskId: '2', status: 'completed' }),
    ).toBe('#2 → completed');
  });
});

describe('independent reviews in the conversation', () => {
  it('shows a review as running and completes it with its result', () => {
    let items = buildConversation([
      event({
        type: 'review.started',
        reviewId: 'r1',
        trigger: 'auto',
        model: 'claude-fable-5-2',
        effort: 'high',
        fileCount: 2,
        repositories: ['alice/app'],
      }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'review',
        key: 'review:r1',
        trigger: 'auto',
        outcome: null,
        findings: [],
      }),
    ]);
    const finding = {
      severity: 'high' as const,
      repository: 'alice/app',
      file: 'a.ts',
      line: 3,
      title: 'Wrong',
      detail: 'Because',
    };
    items = applyEvent(
      items,
      event({
        type: 'review.finished',
        reviewId: 'r1',
        outcome: 'finished',
        summary: 'One issue.',
        findings: [finding],
        error: null,
        durationMs: 5000,
        usage,
        messageId: 'm1',
      }),
    );
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'review',
        outcome: 'finished',
        summary: 'One issue.',
        findings: [finding],
        durationMs: 5000,
        messageId: 'm1',
      }),
    ]);
  });
});
