import { randomUUID } from 'node:crypto';
import type {
  AssistantDraft,
  LogPosition,
  SessionEvent,
  SessionEventInput,
} from '@claude-remote-manager/shared-types';
import type { StoredEvent } from './session-event.repository';
import type { TranscriptEntry } from './sdk-event-mapper';

/** What a subscriber gets: whole log or the part after its position. */
export interface LogSnapshot {
  logId: string;
  complete: boolean;
  events: SessionEvent[];
  drafts: AssistantDraft[];
}

const draftKey = (messageId: string, blockIndex: number) =>
  `${messageId}:${blockIndex}`;

/**
 * The event log of a session in this server process. Streamed text deltas
 * are not kept: only the text of blocks still streaming (drafts), which a
 * complete `assistant.text` event replaces in constant time.
 */
export class SessionLog {
  readonly id = randomUUID();
  private readonly events_: SessionEvent[] = [];
  private readonly drafts = new Map<string, AssistantDraft>();
  private nextSeq = 1;
  private lastText: string | null = null;

  /** All events of the log, oldest first (do not modify). */
  get events(): readonly SessionEvent[] {
    return this.events_;
  }

  /** Text of the last complete assistant text block. */
  get lastAssistantText(): string | null {
    return this.lastText;
  }

  /** Adds an event (deltas only update drafts) and returns it with seq. */
  append(
    input: SessionEventInput,
    at: string | null = new Date().toISOString(),
  ): SessionEvent {
    const event = { ...input, seq: this.nextSeq++, at } as SessionEvent;
    if (event.type === 'assistant.delta') {
      const key = draftKey(event.messageId, event.blockIndex);
      const draft = this.drafts.get(key);
      this.drafts.set(key, {
        messageId: event.messageId,
        blockIndex: event.blockIndex,
        text: (draft?.text ?? '') + event.text,
        parentToolUseId: event.parentToolUseId,
      });
      return event;
    }
    if (event.type === 'assistant.text') {
      if (event.blockIndex !== null) {
        this.drafts.delete(draftKey(event.messageId, event.blockIndex));
      }
      this.lastText = event.text;
    }
    this.events_.push(event);
    return event;
  }

  /** Drops drafts of an ended process; their text will never complete. */
  clearDrafts(): void {
    this.drafts.clear();
  }

  /** Last event of a type, e.g. the latest context usage. */
  findLast<T extends SessionEvent['type']>(
    type: T,
  ): Extract<SessionEvent, { type: T }> | undefined {
    for (let index = this.events_.length - 1; index >= 0; index--) {
      const event = this.events_[index];
      if (event.type === type) {
        return event as Extract<SessionEvent, { type: T }>;
      }
    }
    return undefined;
  }

  snapshot(after?: LogPosition): LogSnapshot {
    const drafts = [...this.drafts.values()];
    if (!after || after.logId !== this.id || after.seq >= this.nextSeq) {
      return {
        logId: this.id,
        complete: true,
        events: [...this.events_],
        drafts,
      };
    }
    return {
      logId: this.id,
      complete: false,
      events: this.events_.slice(this.firstIndexAfter(after.seq)),
      drafts,
    };
  }

  /** Index of the first event with a seq greater than `seq` (binary search). */
  private firstIndexAfter(seq: number): number {
    let low = 0;
    let high = this.events_.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.events_[middle].seq <= seq) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }
}

/** An event to put into a rebuilt log, with its time if known. */
export interface HistoryItem {
  event: SessionEventInput;
  at: string | null;
}

/**
 * Merges the transcript (conversation, without timestamps) with the stored
 * app events. A stored event goes right after the transcript entry it was
 * anchored to; if that entry is unknown (e.g. compacted away), at the end of
 * its user message's turn; otherwise (also without anchor) at the end.
 * Of the prompt suggestions only the newest is kept, and only if it can be
 * placed (with a transcript).
 */
export function buildHistory(
  entries: TranscriptEntry[],
  stored: StoredEvent[],
): HistoryItem[] {
  // Only the newest prompt suggestion can still apply; an older one placed
  // later (its entry compacted away) would otherwise win.
  const newestSuggestion = stored.findLast(
    (item) => item.event.type === 'prompt.suggestion',
  );
  stored = stored.filter(
    (item) =>
      item.event.type !== 'prompt.suggestion' || item === newestSuggestion,
  );
  const entryIds = new Set(entries.map((entry) => entry.uuid));
  const userIds = new Set(
    entries.filter((entry) => entry.isUserMessage).map((entry) => entry.uuid),
  );
  const afterEntry = new Map<string, StoredEvent[]>();
  const endOfTurn = new Map<string, StoredEvent[]>();
  const last: StoredEvent[] = [];
  const push = (
    map: Map<string, StoredEvent[]>,
    key: string,
    item: StoredEvent,
  ) => map.set(key, [...(map.get(key) ?? []), item]);
  for (const item of stored) {
    const { uuid, userId } = item.anchor;
    if (uuid && entryIds.has(uuid)) {
      push(afterEntry, uuid, item);
    } else if (userId && userIds.has(userId)) {
      push(endOfTurn, userId, item);
    } else if (item.event.type === 'prompt.suggestion' && entries.length > 0) {
      // Its turn was compacted away, so the user has answered since:
      // placed at the end it would be offered again.
      continue;
    } else {
      // Unknown or no anchor (e.g. a restart notice): at the end.
      last.push(item);
    }
  }

  const items: HistoryItem[] = [];
  const addStored = (list: StoredEvent[] | undefined) => {
    for (const item of list ?? []) {
      items.push({ event: item.event, at: item.createdAt.toISOString() });
    }
  };
  let turn: string | null = null;
  for (const entry of entries) {
    if (entry.isUserMessage) {
      if (turn) {
        addStored(endOfTurn.get(turn));
      }
      turn = entry.uuid;
    }
    for (const event of entry.events) {
      items.push({ event, at: null });
    }
    addStored(afterEntry.get(entry.uuid));
  }
  if (turn) {
    addStored(endOfTurn.get(turn));
  }
  addStored(last);
  return dequeuedAfterQueued(items);
}

/** IDs of the messages these events leave queued (not dequeued), in order. */
export function openQueuedMessages(
  events: Iterable<SessionEventInput>,
): string[] {
  const open = new Set<string>();
  for (const event of events) {
    if (event.type === 'message.queued') {
      open.add(event.id);
    } else if (event.type === 'message.dequeued') {
      open.delete(event.id);
    }
  }
  return [...open];
}

/**
 * Moves each `message.dequeued` that was placed before its
 * `message.queued` right after it. Their anchors can put them in the wrong
 * order (the queued one's entry is not in the transcript, e.g. a
 * subagent's message), which would leave the message shown as queued.
 */
function dequeuedAfterQueued(items: HistoryItem[]): HistoryItem[] {
  // Queued messages not placed yet.
  const queued = new Set(
    items.flatMap(({ event }) =>
      event.type === 'message.queued' ? [event.id] : [],
    ),
  );
  const held = new Map<string, HistoryItem[]>();
  const result: HistoryItem[] = [];
  for (const item of items) {
    const { event } = item;
    if (event.type === 'message.dequeued' && queued.has(event.id)) {
      held.set(event.id, [...(held.get(event.id) ?? []), item]);
      continue;
    }
    result.push(item);
    if (event.type === 'message.queued') {
      queued.delete(event.id);
      result.push(...(held.get(event.id) ?? []));
      held.delete(event.id);
    }
  }
  return result;
}
