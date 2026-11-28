import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE, type AppDatabase } from '../db/database';
import { messageTimes } from '../db/schema';

/** When the user's messages went into the conversation (see the table). */
@Injectable()
export class MessageTimeRepository {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  /** Records (or, for a message sent again, moves) a message's time. */
  save(sessionId: string, messageId: string, sentAt: Date): void {
    this.db
      .insert(messageTimes)
      .values({ sessionId, messageId, sentAt })
      .onConflictDoUpdate({
        target: [messageTimes.sessionId, messageTimes.messageId],
        set: { sentAt },
      })
      .run();
  }

  /** The times of a session's messages (ISO 8601), by message ID. */
  forSession(sessionId: string): Map<string, string> {
    const rows = this.db
      .select()
      .from(messageTimes)
      .where(eq(messageTimes.sessionId, sessionId))
      .all();
    return new Map(
      rows.map((row) => [row.messageId, row.sentAt.toISOString()]),
    );
  }
}
