import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { SessionEventInput } from '@claude-remote-manager/shared-types';
import { DATABASE, type AppDatabase } from '../db/database';
import { sessionEvents } from '../db/schema';

/**
 * Event types the app produces itself, i.e. that are not in the Claude Code
 * transcript. They are stored; conversation events (user and assistant
 * text, tool calls and results) are rebuilt from the transcript, and status
 * changes and text deltas are live-only. Diffs of file changes are stored:
 * the transcript as the Agent SDK returns it lacks Claude Code's structured
 * tool results.
 */
export const STORED_EVENT_TYPES: ReadonlySet<SessionEventInput['type']> =
  new Set([
    'tool.diff',
    'permission.request',
    'permission.resolved',
    'permission.denied',
    'message.queued',
    'message.dequeued',
    'settings.changed',
    'turn.result',
    'context.usage',
    'notice',
    'error',
    'prepare.progress',
    'setup.output',
    'setup.result',
  ]);

/** Where an event happened relative to the transcript. */
export interface EventAnchor {
  /** Last transcript entry (message UUID) before the event. */
  uuid: string | null;
  /** User message of the turn the event belongs to. */
  userId: string | null;
}

export interface StoredEvent {
  event: SessionEventInput;
  anchor: EventAnchor;
  createdAt: Date;
}

@Injectable()
export class SessionEventRepository {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  add(
    sessionId: string,
    event: SessionEventInput,
    anchor: EventAnchor,
    createdAt = new Date(),
  ): void {
    this.db
      .insert(sessionEvents)
      .values({
        sessionId,
        type: event.type,
        payload: JSON.stringify(event),
        anchorUuid: anchor.uuid,
        anchorUserId: anchor.userId,
        createdAt,
      })
      .run();
  }

  /** Stored events of a session in the order they happened. */
  list(sessionId: string): StoredEvent[] {
    return this.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(asc(sessionEvents.id))
      .all()
      .map((row) => ({
        event: JSON.parse(row.payload) as SessionEventInput,
        anchor: { uuid: row.anchorUuid, userId: row.anchorUserId },
        createdAt: row.createdAt,
      }));
  }
}
