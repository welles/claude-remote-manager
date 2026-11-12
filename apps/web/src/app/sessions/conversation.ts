import type {
  AssistantDraft,
  SessionEvent,
  UsageTotals,
} from '@claude-remote-manager/shared-types';

/** One entry of the rendered conversation. */
export type ConversationItem =
  | { kind: 'user'; key: string; text: string }
  | {
      kind: 'assistant';
      key: string;
      text: string;
      streaming: boolean;
      nested: boolean;
    }
  | {
      kind: 'tool';
      key: string;
      name: string;
      summary: string;
      input: unknown;
      nested: boolean;
      result: { isError: boolean; content: string; truncated: boolean } | null;
      /** Set when the tool use was denied. */
      denied: string | null;
    }
  | { kind: 'notice'; key: string; level: 'info' | 'warning'; text: string }
  | { kind: 'error'; key: string; text: string }
  | {
      kind: 'turn';
      key: string;
      usage: UsageTotals;
      durationMs: number;
      interrupted: boolean;
    };

const MAX_SUMMARY_LENGTH = 120;

/** Short description of a tool call's input, e.g. the command or file. */
export function toolSummary(name: string, input: unknown): string {
  const fields =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const preferred = [
    'command',
    'file_path',
    'path',
    'pattern',
    'url',
    'query',
    'description',
    'prompt',
  ];
  const key = preferred.find((field) => typeof fields[field] === 'string');
  let summary = key
    ? String(fields[key])
    : input === null || input === undefined
      ? ''
      : JSON.stringify(input);
  summary = summary.replace(/\s+/g, ' ').trim();
  return summary.length > MAX_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : summary;
}

const replaceAt = <T>(items: T[], index: number, item: T): T[] => [
  ...items.slice(0, index),
  item,
  ...items.slice(index + 1),
];

/**
 * Applies a session event to the conversation. Returns a new array when
 * something changed (so signals notice), otherwise the same one.
 */
export function applyEvent(
  items: ConversationItem[],
  event: SessionEvent,
): ConversationItem[] {
  switch (event.type) {
    case 'user.message':
      return [
        ...items,
        { kind: 'user', key: `user:${event.id}`, text: event.text },
      ];
    case 'assistant.delta': {
      const key = `text:${event.messageId}:${event.blockIndex}`;
      const index = items.findIndex((item) => item.key === key);
      const existing = items[index];
      if (existing?.kind === 'assistant') {
        return replaceAt(items, index, {
          ...existing,
          text: existing.text + event.text,
        });
      }
      return [
        ...items,
        {
          kind: 'assistant',
          key,
          text: event.text,
          streaming: true,
          nested: event.parentToolUseId !== null,
        },
      ];
    }
    case 'assistant.text': {
      const key =
        event.blockIndex === null
          ? `text:${event.messageId}:seq${event.seq}`
          : `text:${event.messageId}:${event.blockIndex}`;
      const item: ConversationItem = {
        kind: 'assistant',
        key,
        text: event.text,
        streaming: false,
        nested: event.parentToolUseId !== null,
      };
      const index = items.findIndex((existing) => existing.key === key);
      return index >= 0 ? replaceAt(items, index, item) : [...items, item];
    }
    case 'tool.call': {
      const key = `tool:${event.toolUseId}`;
      const index = items.findIndex((item) => item.key === key);
      const existing = items[index];
      const item: ConversationItem = {
        kind: 'tool',
        key,
        name: event.name,
        summary: toolSummary(event.name, event.input),
        input: event.input,
        nested: event.parentToolUseId !== null,
        result: existing?.kind === 'tool' ? existing.result : null,
        denied: existing?.kind === 'tool' ? existing.denied : null,
      };
      return index >= 0 ? replaceAt(items, index, item) : [...items, item];
    }
    case 'tool.result': {
      const index = items.findIndex(
        (item) => item.key === `tool:${event.toolUseId}`,
      );
      const existing = items[index];
      if (existing?.kind !== 'tool') {
        return items;
      }
      return replaceAt(items, index, {
        ...existing,
        result: {
          isError: event.isError,
          content: event.content,
          truncated: event.truncated,
        },
      });
    }
    case 'permission.denied': {
      const key = `tool:${event.toolUseId}`;
      const index = items.findIndex((item) => item.key === key);
      const existing = items[index];
      if (existing?.kind === 'tool') {
        return replaceAt(items, index, { ...existing, denied: event.message });
      }
      return [
        ...items,
        {
          kind: 'tool',
          key,
          name: event.toolName,
          summary: toolSummary(event.toolName, event.input),
          input: event.input,
          nested: false,
          result: null,
          denied: event.message,
        },
      ];
    }
    case 'turn.result':
      return [
        ...items,
        {
          kind: 'turn',
          key: `turn:${event.seq}`,
          usage: event.usage,
          durationMs: event.durationMs,
          interrupted: event.interrupted,
        },
      ];
    case 'notice':
      return [
        ...items,
        {
          kind: 'notice',
          key: `notice:${event.seq}`,
          level: event.level,
          text: event.text,
        },
      ];
    case 'error':
      return [
        ...items,
        { kind: 'error', key: `error:${event.seq}`, text: event.message },
      ];
    default:
      // Status, context usage and reserved permission events are shown
      // elsewhere or not yet.
      return items;
  }
}

/** Shows the streamed text of a block, replacing what the client had. */
export function applyDraft(
  items: ConversationItem[],
  draft: AssistantDraft,
): ConversationItem[] {
  const key = `text:${draft.messageId}:${draft.blockIndex}`;
  const item: ConversationItem = {
    kind: 'assistant',
    key,
    text: draft.text,
    streaming: true,
    nested: draft.parentToolUseId !== null,
  };
  const index = items.findIndex((existing) => existing.key === key);
  return index >= 0 ? replaceAt(items, index, item) : [...items, item];
}

export function buildConversation(events: SessionEvent[]): ConversationItem[] {
  return events.reduce(applyEvent, [] as ConversationItem[]);
}
