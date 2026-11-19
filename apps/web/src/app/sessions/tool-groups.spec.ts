import type {
  SessionEvent,
  SessionEventInput,
} from '@claude-remote-manager/shared-types';
import { buildConversation } from './conversation';
import { groupPreparation } from './preparation';
import { groupTools, shortToolName, toolCounts } from './tool-groups';

let seq = 0;
const event = (input: SessionEventInput): SessionEvent =>
  ({ ...input, seq: ++seq, at: '2026-01-01T00:00:00Z' }) as SessionEvent;

const call = (
  toolUseId: string,
  name = 'Bash',
  parentToolUseId: string | null = null,
) =>
  event({
    type: 'tool.call',
    messageId: 'm',
    toolUseId,
    name,
    input: { command: `echo ${toolUseId}` },
    parentToolUseId,
  });

const text = (
  messageId: string,
  value: string,
  parentToolUseId = null as string | null,
) =>
  event({
    type: 'assistant.text',
    messageId,
    blockIndex: 0,
    text: value,
    parentToolUseId,
  });

const entries = (events: SessionEvent[]) =>
  groupTools(groupPreparation(buildConversation(events)));

describe('tool groups', () => {
  it('folds a run of tool calls between messages into one group', () => {
    const result = entries([
      event({ type: 'user.message', id: 'u1', text: 'Hi' }),
      text('m1', 'Let me look.'),
      call('t1'),
      call('t2', 'Read'),
      call('t3'),
      text('m2', 'Found it.'),
      call('t4'),
    ]);
    expect(result.map((entry) => entry.kind)).toEqual([
      'user',
      'assistant',
      'tools',
      'assistant',
      'tool',
    ]);
    const group = result[2];
    expect(
      group.kind === 'tools' && group.tools.map((tool) => tool.key),
    ).toEqual(['tool:t1', 'tool:t2', 'tool:t3']);
    expect(group.key).toBe('tools:tool:t1');
  });

  it("keeps a subagent's calls and text in the group", () => {
    const result = entries([
      call('agent', 'Agent'),
      call('n1', 'Read', 'agent'),
      text('m3', 'Subagent notes', 'agent'),
      call('n2', 'Grep', 'agent'),
    ]);
    expect(result).toHaveLength(1);
    const group = result[0];
    expect(group.kind).toBe('tools');
    if (group.kind === 'tools') {
      expect(group.items.map((item) => item.kind)).toEqual([
        'tool',
        'tool',
        'assistant',
        'tool',
      ]);
      expect(group.tools).toHaveLength(3);
    }
  });

  it('leaves a single call with only subagent text as it is', () => {
    const result = entries([
      call('agent', 'Agent'),
      text('m3', 'Subagent notes', 'agent'),
    ]);
    expect(result.map((entry) => entry.kind)).toEqual(['tool', 'assistant']);
  });

  it('counts tools by name, most used first, MCP tools by their own name', () => {
    const tools = entries([
      call('t1', 'Read'),
      call('t2'),
      call('t3'),
      call('t4', 'mcp__claude_ai_Gmail__send_message'),
    ]).flatMap((entry) => (entry.kind === 'tools' ? entry.tools : []));
    expect(toolCounts(tools)).toBe('Bash 2 · Read · send_message');
    expect(shortToolName('mcp__crm__show_file')).toBe('show_file');
    expect(shortToolName('Bash')).toBe('Bash');
  });
});
