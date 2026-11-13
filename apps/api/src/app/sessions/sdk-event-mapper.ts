import type {
  SDKMessage,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { SessionEventInput } from '@claude-remote-manager/shared-types';
import { diffFromToolResult, FILE_CHANGE_TOOLS } from '../diffs/tool-diffs';

/** Tool results longer than this are truncated in events. */
export const MAX_TOOL_RESULT_LENGTH = 8000;

type ContentBlock = { type?: unknown; [key: string]: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const blocksOf = (content: unknown): ContentBlock[] =>
  Array.isArray(content) ? content.filter(isRecord) : [];

/** Text of a tool result's content (a string or text blocks). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  return blocksOf(content)
    .map((block) =>
      block.type === 'text' && typeof block['text'] === 'string'
        ? block['text']
        : `[${String(block.type ?? 'unknown')} content]`,
    )
    .join('\n');
}

function truncate(text: string): { content: string; truncated: boolean } {
  return text.length > MAX_TOOL_RESULT_LENGTH
    ? { content: text.slice(0, MAX_TOOL_RESULT_LENGTH), truncated: true }
    : { content: text, truncated: false };
}

/** Events for the content blocks of an assistant message. */
export function assistantContentEvents(
  messageId: string,
  content: unknown,
  parentToolUseId: string | null,
  nextTextBlockIndex: () => number | null = () => null,
): SessionEventInput[] {
  const events: SessionEventInput[] = [];
  for (const block of blocksOf(content)) {
    if (block.type === 'text' && typeof block['text'] === 'string') {
      events.push({
        type: 'assistant.text',
        messageId,
        blockIndex: nextTextBlockIndex(),
        text: block['text'],
        parentToolUseId,
      });
    } else if (
      (block.type === 'tool_use' ||
        block.type === 'server_tool_use' ||
        block.type === 'mcp_tool_use') &&
      typeof block['id'] === 'string'
    ) {
      events.push({
        type: 'tool.call',
        messageId,
        toolUseId: block['id'],
        name: String(block['name'] ?? 'unknown'),
        input: block['input'] ?? null,
        parentToolUseId,
      });
    }
  }
  return events;
}

/**
 * Prefixes of user-role text that Claude Code adds itself (command output,
 * reminders, interruption markers) rather than the user typing it.
 */
const GENERATED_USER_TEXT = /^\s*(<[a-z-]+>|\[Request interrupted)/;

/**
 * Events for the content of a user-role message: tool results, and, when
 * `includeText` is set (history from a transcript), the user's text.
 */
export function userContentEvents(
  id: string,
  content: unknown,
  parentToolUseId: string | null,
  includeText: boolean,
): SessionEventInput[] {
  const events: SessionEventInput[] = [];
  const texts: string[] = typeof content === 'string' ? [content] : [];
  for (const block of blocksOf(content)) {
    if (
      block.type === 'tool_result' &&
      typeof block['tool_use_id'] === 'string'
    ) {
      events.push({
        type: 'tool.result',
        toolUseId: block['tool_use_id'],
        isError: block['is_error'] === true,
        ...truncate(toolResultText(block['content'])),
        parentToolUseId,
      });
    } else if (block.type === 'text' && typeof block['text'] === 'string') {
      texts.push(block['text']);
    }
  }
  if (includeText && parentToolUseId === null) {
    // Interruptions are shown through the stored turn result instead.
    for (const text of texts) {
      if (!GENERATED_USER_TEXT.test(text) && text.trim()) {
        events.push({ type: 'user.message', id, text });
      }
    }
  }
  return events;
}

/**
 * Maps the messages of one running Claude Code process to session events.
 * Keeps the state needed to tie streamed text deltas to the complete text
 * blocks that follow them. Result, init and rate limit messages are handled
 * by the session itself; they need more than a mapping.
 */
export class SdkEventMapper {
  /** Current streamed message ID per thread (main thread: `''`). */
  private readonly streamingMessage = new Map<string, string>();
  /** Indices of streamed text blocks not yet completed, per message ID. */
  private readonly pendingTextBlocks = new Map<string, number[]>();
  /** File-changing tool calls waiting for their result, by tool use ID. */
  private readonly fileCalls = new Map<
    string,
    { name: string; input: unknown }
  >();

  map(message: SDKMessage): SessionEventInput[] {
    switch (message.type) {
      case 'stream_event':
        return this.mapStreamEvent(message);
      case 'assistant': {
        const { id, content } = message.message;
        const events = assistantContentEvents(
          id,
          content,
          message.parent_tool_use_id,
          () => this.pendingTextBlocks.get(id)?.shift() ?? null,
        );
        if (message.error) {
          events.push({
            type: 'notice',
            level: 'warning',
            text: `API error: ${message.error}`,
          });
        }
        for (const event of events) {
          if (event.type === 'tool.call' && FILE_CHANGE_TOOLS.has(event.name)) {
            this.fileCalls.set(event.toolUseId, {
              name: event.name,
              input: event.input,
            });
          }
        }
        return events;
      }
      case 'user': {
        const events = userContentEvents(
          message.uuid ?? '',
          message.message.content,
          message.parent_tool_use_id,
          false,
        );
        return [...events, ...this.toolDiffs(events, message.tool_use_result)];
      }
      case 'system':
        return this.mapSystem(message);
      default:
        return [];
    }
  }

  /**
   * Diffs of file changes whose results are in `events`, from Claude Code's
   * structured result (`tool_use_result`: one per user message, the result
   * of its tool call).
   */
  private toolDiffs(
    events: SessionEventInput[],
    structured: unknown,
  ): SessionEventInput[] {
    const diffs: SessionEventInput[] = [];
    for (const event of events) {
      if (event.type !== 'tool.result') {
        continue;
      }
      const call = this.fileCalls.get(event.toolUseId);
      if (!call) {
        continue;
      }
      this.fileCalls.delete(event.toolUseId);
      const diff = event.isError
        ? null
        : diffFromToolResult(call.name, call.input, structured);
      if (diff) {
        diffs.push({
          type: 'tool.diff',
          toolUseId: event.toolUseId,
          diff,
          source: 'result',
          parentToolUseId: event.parentToolUseId,
        });
      }
    }
    return diffs;
  }

  private mapStreamEvent(
    message: Extract<SDKMessage, { type: 'stream_event' }>,
  ): SessionEventInput[] {
    const thread = message.parent_tool_use_id ?? '';
    const event = message.event;
    switch (event.type) {
      case 'message_start':
        this.streamingMessage.set(thread, event.message.id);
        return [];
      case 'content_block_start': {
        const messageId = this.streamingMessage.get(thread);
        if (messageId && event.content_block.type === 'text') {
          const pending = this.pendingTextBlocks.get(messageId) ?? [];
          pending.push(event.index);
          this.pendingTextBlocks.set(messageId, pending);
        }
        return [];
      }
      case 'content_block_delta': {
        const messageId = this.streamingMessage.get(thread);
        if (!messageId || event.delta.type !== 'text_delta') {
          return [];
        }
        return [
          {
            type: 'assistant.delta',
            messageId,
            blockIndex: event.index,
            text: event.delta.text,
            parentToolUseId: message.parent_tool_use_id,
          },
        ];
      }
      default:
        return [];
    }
  }

  private mapSystem(
    message: Extract<SDKMessage, { type: 'system' }>,
  ): SessionEventInput[] {
    switch (message.subtype) {
      case 'api_retry':
        return [
          {
            type: 'notice',
            level: 'warning',
            text: `API request failed (${message.error_status ?? message.error}), retrying (attempt ${message.attempt} of ${message.max_retries}).`,
          },
        ];
      case 'compact_boundary':
        return [
          {
            type: 'notice',
            level: 'info',
            text: `Conversation compacted (${message.compact_metadata.trigger}, ${message.compact_metadata.pre_tokens} tokens before).`,
          },
        ];
      case 'permission_denied':
        return [
          {
            type: 'permission.denied',
            toolUseId: message.tool_use_id,
            toolName: message.tool_name,
            input: null,
            message: message.message,
            reason: 'rule',
          },
        ];
      default:
        return [];
    }
  }
}

/** The events of one transcript entry. */
export interface TranscriptEntry {
  /** UUID of the transcript entry (the client's ID for user messages). */
  uuid: string;
  /** Whether the entry is a message the user typed. */
  isUserMessage: boolean;
  events: SessionEventInput[];
}

/** Events of a stored transcript, per entry (session history). */
export function transcriptEntries(
  messages: SessionMessage[],
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    if (!isRecord(message.message)) {
      continue;
    }
    const content = message.message['content'];
    let events: SessionEventInput[] = [];
    if (message.type === 'assistant') {
      const id =
        typeof message.message['id'] === 'string'
          ? message.message['id']
          : message.uuid;
      events = assistantContentEvents(id, content, message.parent_tool_use_id);
    } else if (message.type === 'user') {
      events = userContentEvents(
        message.uuid,
        content,
        message.parent_tool_use_id,
        true,
      );
    }
    entries.push({
      uuid: message.uuid,
      isUserMessage: events.some((event) => event.type === 'user.message'),
      events,
    });
  }
  return entries;
}
