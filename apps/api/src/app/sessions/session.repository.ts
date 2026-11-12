import { Inject, Injectable } from '@nestjs/common';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import type {
  SessionPermissionMode,
  SessionStatus,
} from '@claude-remote-manager/shared-types';
import { DATABASE, type AppDatabase } from '../db/database';
import { sessionDirectories, sessions, type SessionRow } from '../db/schema';

/** A session's persisted metadata. */
export interface SessionRecord {
  id: string;
  sdkSessionId: string | null;
  title: string | null;
  model: string | null;
  permissionMode: SessionPermissionMode;
  status: SessionStatus;
  cwd: string;
  additionalDirectories: string[];
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewSession {
  id: string;
  title: string | null;
  model: string | null;
  permissionMode: SessionPermissionMode;
  status: SessionStatus;
  cwd: string;
  additionalDirectories: string[];
}

export type SessionPatch = Partial<
  Pick<SessionRecord, 'sdkSessionId' | 'title' | 'status' | 'lastError'>
>;

@Injectable()
export class SessionRepository {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  create(session: NewSession, now = new Date()): SessionRecord {
    const { additionalDirectories, ...columns } = session;
    this.db.transaction((tx) => {
      tx.insert(sessions)
        .values({ ...columns, createdAt: now, updatedAt: now })
        .run();
      if (additionalDirectories.length > 0) {
        tx.insert(sessionDirectories)
          .values(
            additionalDirectories.map((path, position) => ({
              sessionId: session.id,
              position,
              path,
            })),
          )
          .run();
      }
    });
    return this.require(session.id);
  }

  get(id: string): SessionRecord | undefined {
    const row = this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    return row ? this.withDirectories([row])[0] : undefined;
  }

  require(id: string): SessionRecord {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    return session;
  }

  /** All sessions, most recently updated first. */
  list(): SessionRecord[] {
    const rows = this.db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.updatedAt), desc(sessions.createdAt))
      .all();
    return this.withDirectories(rows);
  }

  update(id: string, patch: SessionPatch, now = new Date()): SessionRecord {
    this.db
      .update(sessions)
      .set({ ...patch, updatedAt: now })
      .where(eq(sessions.id, id))
      .run();
    return this.require(id);
  }

  /**
   * Sets sessions that are still marked running to waiting and returns their
   * IDs. Used on startup: their turns ended with the previous server process.
   */
  stopRunningSessions(now = new Date()): string[] {
    return this.db
      .update(sessions)
      .set({ status: 'waiting', updatedAt: now })
      .where(eq(sessions.status, 'running'))
      .returning({ id: sessions.id })
      .all()
      .map((row) => row.id);
  }

  private withDirectories(rows: SessionRow[]): SessionRecord[] {
    if (rows.length === 0) {
      return [];
    }
    const directories = this.db
      .select()
      .from(sessionDirectories)
      .where(
        inArray(
          sessionDirectories.sessionId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(sessionDirectories.position))
      .all();
    return rows.map((row) => ({
      ...row,
      additionalDirectories: directories
        .filter((directory) => directory.sessionId === row.id)
        .map((directory) => directory.path),
    }));
  }
}
