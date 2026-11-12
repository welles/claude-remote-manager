import type {
  SDKMessage,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  MAX_TOOL_RESULT_LENGTH,
  SdkEventMapper,
  toolResultText,
  transcriptEntries,
} from './sdk-event-mapper';

/** Builds SDK messages; only the fields the mapper reads are relevant. */
const sdk = (message: Record<string, unknown>) =>
  ({ uuid: 'u', session_id: 's', ...message }) as unknown as SDKMessage;

const stream = (event: Record<string, unknown>, parent: string | null = null) =>
  sdk({ type: 'stream_event', event, parent_tool_use_id: parent });

const assistant = (
  id: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
) =>
  sdk({
    type: 'assistant',
    message: { id, role: 'assistant', content },
    parent_tool_use_id: null,
    ...extra,
  });

describe('SdkEventMapper', () => {
  let mapper: SdkEventMapper;

  beforeEach(() => {
    mapper = new SdkEventMapper();
  });

  it('streams text deltas and ties the complete block to them', () => {
    expect(
      mapper.map(stream({ type: 'message_start', message: { id: 'm1' } })),
    ).toEqual([]);
    mapper.map(
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking' },
      }),
    );
    mapper.map(
      stream({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text' },
      }),
    );
    expect(
      mapper.map(
        stream({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Hel' },
        }),
      ),
    ).toEqual([
      {
        type: 'assistant.delta',
        messageId: 'm1',
        blockIndex: 1,
        text: 'Hel',
        parentToolUseId: null,
      },
    ]);
    expect(
      mapper.map(
        stream({
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{' },
        }),
      ),
    ).toEqual([]);

    expect(
      mapper.map(assistant('m1', [{ type: 'text', text: 'Hello' }])),
    ).toEqual([
      {
        type: 'assistant.text',
        messageId: 'm1',
        blockIndex: 1,
        text: 'Hello',
        parentToolUseId: null,
      },
    ]);
    // A second text block of the same message was not streamed.
    expect(
      mapper.map(assistant('m1', [{ type: 'text', text: 'More' }])),
    ).toEqual([
      expect.objectContaining({ type: 'assistant.text', blockIndex: null }),
    ]);
  });

  it('keeps streams of subagents apart from the main thread', () => {
    mapper.map(stream({ type: 'message_start', message: { id: 'main' } }));
    mapper.map(
      stream({ type: 'message_start', message: { id: 'sub' } }, 'tool-1'),
    );
    expect(
      mapper.map(
        stream(
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'x' },
          },
          'tool-1',
        ),
      ),
    ).toEqual([
      expect.objectContaining({ messageId: 'sub', parentToolUseId: 'tool-1' }),
    ]);
  });

  it('maps tool calls and results', () => {
    expect(
      mapper.map(
        assistant('m2', [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ]),
      ),
    ).toEqual([
      {
        type: 'tool.call',
        messageId: 'm2',
        toolUseId: 't1',
        name: 'Bash',
        input: { command: 'ls' },
        parentToolUseId: null,
      },
    ]);

    expect(
      mapper.map(
        sdk({
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: 'a.txt',
                is_error: false,
              },
              {
                type: 'tool_result',
                tool_use_id: 't2',
                content: [{ type: 'text', text: 'denied' }],
                is_error: true,
              },
              { type: 'text', text: 'not shown live' },
            ],
          },
        }),
      ),
    ).toEqual([
      {
        type: 'tool.result',
        toolUseId: 't1',
        isError: false,
        content: 'a.txt',
        truncated: false,
        parentToolUseId: null,
      },
      {
        type: 'tool.result',
        toolUseId: 't2',
        isError: true,
        content: 'denied',
        truncated: false,
        parentToolUseId: null,
      },
    ]);
  });

  it('truncates long tool results', () => {
    const [event] = mapper.map(
      sdk({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't',
              content: 'x'.repeat(MAX_TOOL_RESULT_LENGTH + 5),
            },
          ],
        },
      }),
    );
    expect(event).toMatchObject({ truncated: true });
    expect((event as { content: string }).content).toHaveLength(
      MAX_TOOL_RESULT_LENGTH,
    );
  });

  it('reports API errors on assistant messages', () => {
    expect(
      mapper.map(
        assistant('m3', [{ type: 'text', text: 'Sorry' }], {
          error: 'rate_limit',
        }),
      ),
    ).toEqual([
      expect.objectContaining({ type: 'assistant.text' }),
      { type: 'notice', level: 'warning', text: 'API error: rate_limit' },
    ]);
  });

  it('maps retries, compaction and permission denials', () => {
    expect(
      mapper.map(
        sdk({
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 3,
          retry_delay_ms: 10,
          error_status: 529,
          error: 'overloaded',
        }),
      ),
    ).toEqual([
      {
        type: 'notice',
        level: 'warning',
        text: 'API request failed (529), retrying (attempt 1 of 3).',
      },
    ]);
    expect(
      mapper.map(
        sdk({
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 1000 },
        }),
      ),
    ).toEqual([expect.objectContaining({ type: 'notice', level: 'info' })]);
    expect(
      mapper.map(
        sdk({
          type: 'system',
          subtype: 'permission_denied',
          tool_name: 'Bash',
          tool_use_id: 't9',
          message: 'Denied by rule',
        }),
      ),
    ).toEqual([
      {
        type: 'permission.denied',
        toolUseId: 't9',
        toolName: 'Bash',
        input: null,
        message: 'Denied by rule',
        reason: 'rule',
      },
    ]);
  });

  it('ignores messages without session events', () => {
    expect(mapper.map(sdk({ type: 'system', subtype: 'init' }))).toEqual([]);
    expect(
      mapper.map(
        sdk({ type: 'system', subtype: 'status', status: 'requesting' }),
      ),
    ).toEqual([]);
    expect(mapper.map(sdk({ type: 'tool_progress' }))).toEqual([]);
  });
});

/** All events of the transcript entries, flattened. */
const transcriptEvents = (messages: SessionMessage[]) =>
  transcriptEntries(messages).flatMap((entry) => entry.events);

describe('transcriptEntries', () => {
  const entry = (
    type: SessionMessage['type'],
    message: unknown,
    uuid = 'e',
  ): SessionMessage => ({
    type,
    uuid,
    session_id: 's',
    message,
    parent_tool_use_id: null,
    parent_agent_id: null,
  });

  it('rebuilds the conversation from a transcript', () => {
    expect(
      transcriptEvents([
        entry('user', { role: 'user', content: 'Say pong' }, 'u1'),
        entry('assistant', {
          id: 'm1',
          content: [{ type: 'text', text: 'pong' }],
        }),
        entry('assistant', {
          id: 'm2',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        }),
        entry('user', {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
        }),
        entry(
          'user',
          { role: 'user', content: [{ type: 'text', text: 'Again' }] },
          'u2',
        ),
      ]),
    ).toEqual([
      { type: 'user.message', id: 'u1', text: 'Say pong' },
      {
        type: 'assistant.text',
        messageId: 'm1',
        blockIndex: null,
        text: 'pong',
        parentToolUseId: null,
      },
      expect.objectContaining({
        type: 'tool.call',
        toolUseId: 't1',
        messageId: 'm2',
      }),
      expect.objectContaining({
        type: 'tool.result',
        toolUseId: 't1',
        content: 'ok',
      }),
      { type: 'user.message', id: 'u2', text: 'Again' },
    ]);
  });

  it('groups events by entry and marks user messages', () => {
    expect(
      transcriptEntries([
        entry('user', { role: 'user', content: 'Hi' }, 'u1'),
        entry('assistant', { id: 'm1', content: [] }, 'a1'),
        entry(
          'user',
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't' }],
          },
          'r1',
        ),
      ]).map(({ uuid, isUserMessage, events }) => [
        uuid,
        isUserMessage,
        events.length,
      ]),
    ).toEqual([
      ['u1', true, 1],
      ['a1', false, 0],
      ['r1', false, 1],
    ]);
  });

  it('hides text Claude Code generated, including interruption markers', () => {
    expect(
      transcriptEvents([
        entry('user', {
          role: 'user',
          content: '<command-name>/clear</command-name>',
        }),
        entry('user', {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        }),
        entry('system', { content: 'ignored' }),
        entry('assistant', 'not an object'),
      ]),
    ).toEqual([]);
  });
});

describe('toolResultText', () => {
  it('joins text blocks and names other blocks', () => {
    expect(
      toolResultText([
        { type: 'text', text: 'a' },
        { type: 'image', source: {} },
      ]),
    ).toBe('a\n[image content]');
    expect(toolResultText(undefined)).toBe('');
  });
});
