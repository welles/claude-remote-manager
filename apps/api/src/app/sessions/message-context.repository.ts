import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { MessageReference } from '@claude-remote-manager/shared-types';
import { DATABASE, type AppDatabase } from '../db/database';
import { messageContexts } from '../db/schema';

/** What the app gave Claude with one user message (see the table). */
export interface MessageContextRecord {
  messageId: string;
  sessionId: string;
  origin: 'user' | 'app';
  references: MessageReference[];
  /** Transcript UUID of the context message; `null` without context. */
  contextId: string | null;
  context: string | null;
}

/** What a history needs of a message's context (not the text itself). */
export interface MessageContextSummary {
  origin: 'user' | 'app';
  references: MessageReference[];
  contextId: string | null;
  contextLength: number | null;
}

@Injectable()
export class MessageContextRepository {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  /** Stores (or replaces, for a message sent again) a message's context. */
  save(record: MessageContextRecord): void {
    const values = {
      sessionId: record.sessionId,
      origin: record.origin,
      references: JSON.stringify(record.references),
      contextId: record.contextId,
      context: record.context,
    };
    this.db
      .insert(messageContexts)
      .values({ messageId: record.messageId, ...values })
      .onConflictDoUpdate({ target: messageContexts.messageId, set: values })
      .run();
  }

  get(sessionId: string, messageId: string): MessageContextRecord | null {
    const row = this.db
      .select()
      .from(messageContexts)
      .where(
        and(
          eq(messageContexts.sessionId, sessionId),
          eq(messageContexts.messageId, messageId),
        ),
      )
      .get();
    return row
      ? {
          messageId: row.messageId,
          sessionId: row.sessionId,
          origin: row.origin,
          references: JSON.parse(row.references) as MessageReference[],
          contextId: row.contextId,
          context: row.context,
        }
      : null;
  }

  /** Summaries of a session's messages, by message ID. */
  forSession(sessionId: string): Map<string, MessageContextSummary> {
    const rows = this.db
      .select({
        messageId: messageContexts.messageId,
        origin: messageContexts.origin,
        references: messageContexts.references,
        contextId: messageContexts.contextId,
        contextLength: sql<number | null>`length(${messageContexts.context})`,
      })
      .from(messageContexts)
      .where(eq(messageContexts.sessionId, sessionId))
      .all();
    return new Map(
      rows.map((row) => [
        row.messageId,
        {
          origin: row.origin,
          references: JSON.parse(row.references) as MessageReference[],
          contextId: row.contextId,
          contextLength: row.contextLength,
        },
      ]),
    );
  }
}
