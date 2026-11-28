import type { SessionEventInput } from '@claude-remote-manager/shared-types';
import { MAX_TOOL_RESULT_LENGTH } from '../sdk-event-mapper';
import type { AgentEvent } from '../agent-events';
import {
  CodexEventTranslator,
  codexChangeDiff,
  codexContextUsage,
  codexHistory,
  codexModel,
  codexPlanUsage,
  codexRateLimits,
  codexToolName,
  codexUsageTotals,
} from './codex-events';
import type {
  CodexRateLimitSnapshot,
  CodexThreadItem,
  CodexThreadTokenUsage,
  CodexTurn,
} from './codex-protocol';

const THREAD = 'thread-1';

/** The log events of a batch's `output` events. */
const outputs = (events: AgentEvent[]): SessionEventInput[] =>
  events.flatMap((event) => (event.type === 'output' ? event.events : []));

const usage = (total: number, cached = 0) => ({
  totalTokens: total,
  inputTokens: Math.round(total * 0.8),
  cachedInputTokens: cached,
  cacheWriteInputTokens: 10,
  outputTokens: Math.round(total * 0.2),
  reasoningOutputTokens: 0,
});

const snapshot = (
  overrides: Partial<CodexRateLimitSnapshot> = {},
): CodexRateLimitSnapshot => ({
  limitId: 'codex',
  limitName: null,
  primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1764300000 },
  secondary: {
    usedPercent: 100,
    windowDurationMins: 10080,
    resetsAt: 1764900000,
  },
  planType: 'plus',
  rateLimitReachedType: null,
  ...overrides,
});

const turn = (overrides: Partial<CodexTurn> = {}): CodexTurn => ({
  id: 'turn-1',
  items: [],
  status: 'completed',
  error: null,
  durationMs: 1234,
  ...overrides,
});

describe('CodexEventTranslator', () => {
  let translator: CodexEventTranslator;

  beforeEach(() => {
    translator = new CodexEventTranslator(THREAD, 'gpt-5.5-codex');
  });

  const translate = (method: string, params: Record<string, unknown>) =>
    translator.translate(method, { threadId: THREAD, ...params });

  it('streams an agent message and ends it with its text in the same block', () => {
    const item = { type: 'agentMessage', id: 'msg-1', text: '' };
    expect(translate('item/started', { item })).toEqual([{ type: 'activity' }]);
    const delta = translate('item/agentMessage/delta', {
      itemId: 'msg-1',
      delta: 'Hel',
    });
    expect(delta[0]).toEqual({ type: 'activity' });
    expect(outputs(delta)).toEqual([
      {
        type: 'assistant.delta',
        messageId: 'msg-1',
        blockIndex: 0,
        text: 'Hel',
        parentToolUseId: null,
      },
    ]);
    const done = translate('item/completed', {
      item: { ...item, text: 'Hello' },
    });
    expect(done).toEqual([
      {
        type: 'output',
        events: [
          {
            type: 'assistant.text',
            messageId: 'msg-1',
            blockIndex: 0,
            text: 'Hello',
            parentToolUseId: null,
          },
        ],
        anchor: 'msg-1',
        images: [],
        contextChanged: true,
      },
    ]);
  });

  it('gives a message that was not streamed no block index, and skips empty ones', () => {
    const done = translate('item/completed', {
      item: { type: 'agentMessage', id: 'msg-2', text: 'Whole' },
    });
    expect(outputs(done)).toEqual([
      expect.objectContaining({ type: 'assistant.text', blockIndex: null }),
    ]);
    expect(
      translate('item/completed', {
        item: { type: 'agentMessage', id: 'msg-3', text: '' },
      }),
    ).toEqual([]);
  });

  it('anchors on the user message by its client ID', () => {
    expect(
      translate('item/completed', {
        item: {
          type: 'userMessage',
          id: 'user-1',
          clientId: 'client-1',
          content: [{ type: 'text', text: 'hi', text_elements: [] }],
        },
      }),
    ).toEqual([
      {
        type: 'output',
        events: [],
        anchor: 'client-1',
        images: [],
        contextChanged: false,
      },
    ]);
  });

  it('shows a command as Bash with its output, failed on a non-zero exit or a decline', () => {
    const command = {
      type: 'commandExecution',
      id: 'cmd-1',
      command: 'ls -la',
      cwd: '/work',
      status: 'inProgress',
      aggregatedOutput: null,
      exitCode: null,
    };
    expect(outputs(translate('item/started', { item: command }))).toEqual([
      {
        type: 'tool.call',
        messageId: 'cmd-1',
        toolUseId: 'cmd-1',
        name: 'Bash',
        input: { command: 'ls -la', cwd: '/work' },
        parentToolUseId: null,
      },
    ]);
    expect(
      outputs(
        translate('item/completed', {
          item: {
            ...command,
            status: 'completed',
            aggregatedOutput: 'total 0\n',
            exitCode: 0,
          },
        }),
      ),
    ).toEqual([
      {
        type: 'tool.result',
        toolUseId: 'cmd-1',
        isError: false,
        content: 'total 0\n',
        truncated: false,
        parentToolUseId: null,
      },
    ]);
    expect(
      outputs(
        translate('item/completed', {
          item: {
            ...command,
            status: 'completed',
            aggregatedOutput: 'x'.repeat(MAX_TOOL_RESULT_LENGTH + 5),
            exitCode: 2,
          },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        isError: true,
        content: 'x'.repeat(MAX_TOOL_RESULT_LENGTH),
        truncated: true,
      }),
    ]);
    expect(
      outputs(
        translate('item/completed', {
          item: { ...command, status: 'declined' },
        }),
      ),
    ).toEqual([
      expect.objectContaining({ isError: true, content: 'Declined' }),
    ]);
  });

  it('shows file changes as Write and Edit with their diffs', () => {
    const item = {
      type: 'fileChange',
      id: 'patch-1',
      status: 'inProgress',
      changes: [
        {
          path: '/work/new.txt',
          kind: { type: 'add' },
          diff: 'one\ntwo\n',
        },
        {
          path: '/work/old.txt',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n',
        },
      ],
    };
    const started = outputs(translate('item/started', { item }));
    expect(started.map((event) => event.type)).toEqual([
      'tool.call',
      'tool.diff',
      'tool.call',
      'tool.diff',
    ]);
    expect(started[0]).toEqual(
      expect.objectContaining({
        toolUseId: 'patch-1:0',
        name: 'Write',
        input: { file_path: '/work/new.txt' },
      }),
    );
    expect(started[1]).toEqual(
      expect.objectContaining({
        toolUseId: 'patch-1:0',
        source: 'result',
        diff: expect.objectContaining({
          path: '/work/new.txt',
          status: 'added',
          additions: 2,
          deletions: 0,
        }),
      }),
    );
    expect(started[2]).toEqual(
      expect.objectContaining({ toolUseId: 'patch-1:1', name: 'Edit' }),
    );
    expect(started[3]).toEqual(
      expect.objectContaining({
        diff: expect.objectContaining({
          path: '/work/old.txt',
          status: 'modified',
          additions: 1,
          deletions: 1,
        }),
      }),
    );

    expect(
      outputs(
        translate('item/completed', { item: { ...item, status: 'completed' } }),
      ),
    ).toEqual([
      expect.objectContaining({
        toolUseId: 'patch-1:0',
        isError: false,
        content: 'Changed /work/new.txt',
      }),
      expect.objectContaining({
        toolUseId: 'patch-1:1',
        isError: false,
        content: 'Changed /work/old.txt',
      }),
    ]);
    expect(
      outputs(
        translate('item/completed', { item: { ...item, status: 'declined' } }),
      ),
    ).toEqual([
      expect.objectContaining({
        isError: true,
        content: 'Not applied (declined)',
      }),
      expect.objectContaining({ isError: true }),
    ]);
  });

  it('names MCP and dynamic tools like Claude Code, the app’s own under crm', () => {
    expect(codexToolName('docs', 'search')).toBe('mcp__docs__search');
    expect(codexToolName(null, 'merge_pull_request')).toBe(
      'mcp__crm__merge_pull_request',
    );

    const mcp = {
      type: 'mcpToolCall',
      id: 'mcp-1',
      server: 'docs',
      tool: 'search',
      arguments: { q: 'x' },
      result: null,
      error: null,
    };
    expect(outputs(translate('item/started', { item: mcp }))).toEqual([
      expect.objectContaining({
        name: 'mcp__docs__search',
        input: { q: 'x' },
      }),
    ]);
    expect(
      outputs(
        translate('item/completed', {
          item: {
            ...mcp,
            result: { content: [{ type: 'text', text: 'found' }, { n: 1 }] },
          },
        }),
      ),
    ).toEqual([
      expect.objectContaining({ isError: false, content: 'found\n{"n":1}' }),
    ]);
    expect(
      outputs(
        translate('item/completed', {
          item: { ...mcp, error: { message: 'server down' } },
        }),
      ),
    ).toEqual([
      expect.objectContaining({ isError: true, content: 'server down' }),
    ]);

    const dynamic = {
      type: 'dynamicToolCall',
      id: 'call-1',
      namespace: null,
      tool: 'show_file',
      arguments: { path: 'a.png' },
      contentItems: null,
      success: null,
    };
    expect(outputs(translate('item/started', { item: dynamic }))).toEqual([
      expect.objectContaining({
        name: 'mcp__crm__show_file',
        input: { path: 'a.png' },
      }),
    ]);
    expect(
      outputs(
        translate('item/completed', {
          item: {
            ...dynamic,
            contentItems: [
              { type: 'inputText', text: 'shown' },
              { type: 'inputImage' },
            ],
            success: false,
          },
        }),
      ),
    ).toEqual([expect.objectContaining({ isError: true, content: 'shown\n' })]);
  });

  it('shows web searches, image views and compactions', () => {
    expect(
      outputs(
        translate('item/started', {
          item: { type: 'webSearch', id: 'web-1', query: 'codex' },
        }),
      ),
    ).toEqual([
      expect.objectContaining({ name: 'WebSearch', input: { query: 'codex' } }),
    ]);
    expect(
      outputs(
        translate('item/started', {
          item: { type: 'imageView', id: 'img-1', path: '/work/a.png' },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        name: 'Read',
        input: { file_path: '/work/a.png' },
      }),
    ]);
    expect(
      outputs(
        translate('item/completed', {
          item: { type: 'contextCompaction', id: 'c-1' },
        }),
      ),
    ).toEqual([expect.objectContaining({ type: 'notice', level: 'info' })]);
    // Reasoning shows nothing.
    expect(
      translate('item/completed', {
        item: { type: 'reasoning', id: 'r-1', summary: [], content: [] },
      }),
    ).toEqual([]);
  });

  it('shows the plan as TodoWrite with a new tool use per revision', () => {
    const plan = [
      { step: 'Read', status: 'completed' },
      { step: 'Write', status: 'inProgress' },
      { step: 'Run', status: 'pending' },
    ];
    const first = outputs(
      translate('turn/plan/updated', { turnId: 'turn-1', plan }),
    );
    expect(first).toEqual([
      {
        type: 'tool.call',
        messageId: 'turn-1:plan:0',
        toolUseId: 'turn-1:plan:0',
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Read', activeForm: 'Read', status: 'completed' },
            { content: 'Write', activeForm: 'Write', status: 'in_progress' },
            { content: 'Run', activeForm: 'Run', status: 'pending' },
          ],
        },
        parentToolUseId: null,
      },
      expect.objectContaining({
        type: 'tool.result',
        toolUseId: 'turn-1:plan:0',
        isError: false,
      }),
    ]);
    const second = outputs(
      translate('turn/plan/updated', { turnId: 'turn-1', plan }),
    );
    expect(second[0]).toEqual(
      expect.objectContaining({ toolUseId: 'turn-1:plan:1' }),
    );
  });

  it('ignores the notifications of other threads', () => {
    expect(
      translator.translate('item/completed', {
        threadId: 'subagent',
        item: { type: 'agentMessage', id: 'm', text: 'other' },
      }),
    ).toEqual([]);
    expect(translator.translate('unknown/method', {})).toEqual([]);
  });

  it('ends a turn with the thread’s cumulative usage', () => {
    const tokenUsage: CodexThreadTokenUsage = {
      total: usage(5000, 2000),
      last: usage(1500),
      modelContextWindow: 200000,
    };
    expect(translate('thread/tokenUsage/updated', { tokenUsage })).toEqual([]);
    expect(translator.tokenUsage).toEqual(tokenUsage);
    expect(translate('turn/completed', { turn: turn() })).toEqual([
      {
        type: 'result',
        subtype: 'success',
        isError: false,
        text: null,
        errors: [],
        durationMs: 1234,
        numTurns: 1,
        usage: {
          'gpt-5.5-codex': {
            inputTokens: 2000,
            outputTokens: 1000,
            cacheCreationInputTokens: 10,
            cacheReadInputTokens: 2000,
            costUsd: 0,
          },
        },
        engineSessionId: THREAD,
        queuedTurns: 0,
      },
    ]);
  });

  it('reports a failed turn with its message, without usage when none came', () => {
    expect(
      translate('turn/completed', {
        turn: turn({
          status: 'failed',
          error: {
            message: 'stream disconnected',
            codexErrorInfo: 'other',
            additionalDetails: null,
          },
          durationMs: null,
        }),
      }),
    ).toEqual([
      expect.objectContaining({
        isError: true,
        text: 'stream disconnected',
        usage: {},
        durationMs: 0,
      }),
    ]);
    expect(
      translate('turn/completed', { turn: turn({ status: 'failed' }) }),
    ).toEqual([expect.objectContaining({ text: 'The turn failed.' })]);
    // An interrupted turn is no error.
    expect(
      translate('turn/completed', { turn: turn({ status: 'interrupted' }) }),
    ).toEqual([expect.objectContaining({ isError: false, text: null })]);
  });

  it('reports the usage limit as limit-hit and in the result', () => {
    expect(
      translate('error', {
        error: {
          message: '',
          codexErrorInfo: 'usageLimitExceeded',
          additionalDetails: null,
        },
        willRetry: false,
        turnId: 'turn-1',
      }),
    ).toEqual([{ type: 'limit-hit' }]);
    expect(
      translate('turn/completed', {
        turn: turn({
          status: 'failed',
          error: { message: '', codexErrorInfo: null, additionalDetails: null },
        }),
      }),
    ).toEqual([
      expect.objectContaining({
        isError: true,
        text: 'The usage limit of the ChatGPT account was reached.',
      }),
    ]);
    // Only for that turn.
    expect(
      translate('turn/completed', { turn: turn({ status: 'failed' }) }),
    ).toEqual([expect.objectContaining({ text: 'The turn failed.' })]);
    // Other errors are left to the turn's result.
    expect(
      translate('error', {
        error: {
          message: 'overloaded',
          codexErrorInfo: 'serverOverloaded',
          additionalDetails: null,
        },
        willRetry: true,
      }),
    ).toEqual([]);
  });

  it('passes rate limit updates on as limit windows', () => {
    expect(
      translator.translate('account/rateLimits/updated', {
        rateLimits: snapshot(),
      }),
    ).toEqual([
      {
        type: 'rate-limit',
        limit: {
          window: 'five_hour',
          status: 'allowed',
          utilization: 25,
          resetsAt: new Date(1764300000 * 1000).toISOString(),
        },
      },
      {
        type: 'rate-limit',
        limit: {
          window: 'seven_day',
          status: 'rejected',
          utilization: 100,
          resetsAt: new Date(1764900000 * 1000).toISOString(),
        },
      },
    ]);
  });
});

describe('Codex helpers', () => {
  it('names unknown windows and leaves missing ones out', () => {
    expect(
      codexRateLimits(
        snapshot({
          primary: { usedPercent: 5, windowDurationMins: 60, resetsAt: null },
          secondary: null,
        }),
      ),
    ).toEqual([
      {
        window: 'primary',
        status: 'allowed',
        utilization: 5,
        resetsAt: null,
      },
    ]);
  });

  it('reads the plan usage with five_hour and seven_day windows', () => {
    expect(codexPlanUsage(snapshot())).toEqual({
      subscriptionType: 'plus',
      windows: [
        {
          window: 'five_hour',
          label: null,
          utilization: 25,
          resetsAt: '2025-11-28T03:20:00.000Z',
        },
        {
          window: 'seven_day',
          label: null,
          utilization: 100,
          resetsAt: new Date(1764900000 * 1000).toISOString(),
        },
      ],
    });
    expect(
      codexPlanUsage(
        snapshot({
          planType: null,
          primary: { usedPercent: 1, windowDurationMins: 60, resetsAt: null },
          secondary: { usedPercent: 2, windowDurationMins: null, resetsAt: 0 },
        }),
      ),
    ).toEqual({
      subscriptionType: null,
      windows: [
        {
          window: 'primary',
          label: 'Primary window',
          utilization: 1,
          resetsAt: null,
        },
        {
          window: 'secondary',
          label: 'Secondary window',
          utilization: 2,
          resetsAt: '1970-01-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('computes the context usage from the last request', () => {
    expect(
      codexContextUsage(
        { total: usage(90000), last: usage(50000), modelContextWindow: 200000 },
        'gpt-5.5-codex',
      ),
    ).toEqual({
      model: 'gpt-5.5-codex',
      usedTokens: 50000,
      maxTokens: 200000,
      percentage: 25,
    });
    expect(
      codexContextUsage(
        { total: usage(1), last: usage(1), modelContextWindow: null },
        'gpt-5.5-codex',
      ),
    ).toBeNull();
  });

  it('counts cached input apart and never below zero', () => {
    expect(
      codexUsageTotals({
        totalTokens: 10,
        inputTokens: 5,
        cachedInputTokens: 8,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 1,
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 8,
      costUsd: 0,
    });
  });

  it('offers the default model as the default (null)', () => {
    const base = {
      id: 'gpt-5.4',
      model: 'gpt-5.4',
      displayName: 'GPT-5.4',
      description: 'Fast',
      hidden: false,
    };
    expect(codexModel(base)).toEqual({
      value: 'gpt-5.4',
      label: 'GPT-5.4',
      description: 'Fast',
      resolvedModel: 'gpt-5.4',
    });
    expect(codexModel({ ...base, isDefault: true, displayName: '' })).toEqual({
      value: null,
      label: 'gpt-5.4',
      description: 'Fast',
      resolvedModel: 'gpt-5.4',
    });
  });

  it('diffs renames and deletions', () => {
    expect(
      codexChangeDiff({
        path: '/work/a.txt',
        kind: { type: 'update', move_path: '/work/b.txt' },
        diff: '@@ -1 +1 @@\n-a\n+b\n',
      }),
    ).toEqual(
      expect.objectContaining({
        path: '/work/b.txt',
        oldPath: '/work/a.txt',
        status: 'renamed',
        additions: 1,
        deletions: 1,
      }),
    );
    expect(
      codexChangeDiff({
        path: '/work/gone.txt',
        kind: { type: 'delete' },
        diff: '',
      }),
    ).toEqual(
      expect.objectContaining({
        path: '/work/gone.txt',
        oldPath: null,
        status: 'deleted',
        hunks: [],
      }),
    );
  });

  it('builds the history of a thread’s turns', () => {
    const items: CodexThreadItem[] = [
      {
        type: 'userMessage',
        id: 'user-1',
        clientId: 'client-1',
        content: [
          { type: 'text', text: 'context', text_elements: [] },
          { type: 'image', url: 'data:image/png;base64,AA==' },
          { type: 'text', text: 'Do it', text_elements: [] },
        ],
      },
      {
        type: 'commandExecution',
        id: 'cmd-1',
        command: 'make',
        cwd: '/work',
        status: 'completed',
        aggregatedOutput: 'ok',
        exitCode: 0,
      },
      { type: 'agentMessage', id: 'msg-1', text: 'Done' },
      { type: 'reasoning', id: 'r-1', summary: [], content: [] },
    ];
    expect(
      codexHistory([
        turn({ items }),
        turn({
          id: 'turn-2',
          items: [
            { type: 'userMessage', id: 'user-2', clientId: null, content: [] },
          ],
        }),
      ]),
    ).toEqual([
      {
        uuid: 'client-1',
        isUserMessage: true,
        events: [
          { type: 'user.message', id: 'client-1', text: 'context\nDo it' },
        ],
      },
      {
        uuid: 'cmd-1',
        isUserMessage: false,
        events: [
          expect.objectContaining({ type: 'tool.call', name: 'Bash' }),
          expect.objectContaining({
            type: 'tool.result',
            isError: false,
            content: 'ok',
          }),
        ],
      },
      {
        uuid: 'msg-1',
        isUserMessage: false,
        events: [
          {
            type: 'assistant.text',
            messageId: 'msg-1',
            blockIndex: null,
            text: 'Done',
            parentToolUseId: null,
          },
        ],
      },
      { uuid: 'r-1', isUserMessage: false, events: [] },
      {
        uuid: 'user-2',
        isUserMessage: true,
        events: [{ type: 'user.message', id: 'user-2', text: '' }],
      },
    ]);
  });
});
