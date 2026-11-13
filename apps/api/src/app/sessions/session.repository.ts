import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type {
  SessionDirectoryKind,
  SessionDirectoryState,
  SessionPermissionMode,
  SessionStatus,
  SetupStatus,
} from '@claude-remote-manager/shared-types';
import { DATABASE, type AppDatabase } from '../db/database';
import {
  repositories,
  sessionDirectories,
  sessions,
  type SessionRow,
} from '../db/schema';

/** A directory of a session; see `session_directories` in the schema. */
export interface SessionDirectoryRecord {
  position: number;
  path: string;
  kind: SessionDirectoryKind;
  repositoryId: string | null;
  /** `owner/name` of the repository. */
  repositoryName: string | null;
  /** The repository is a local project without remote. */
  repositoryLocal: boolean;
  branch: string | null;
  baseBranch: string | null;
  baseCommit: string | null;
  state: SessionDirectoryState;
  setupStatus: SetupStatus;
}

/** A session's persisted metadata. */
export interface SessionRecord {
  id: string;
  sdkSessionId: string | null;
  title: string | null;
  model: string | null;
  permissionMode: SessionPermissionMode;
  status: SessionStatus;
  slug: string | null;
  pendingMessage: { id: string; text: string } | null;
  /** In order; the first is the working directory. */
  directories: SessionDirectoryRecord[];
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewSessionDirectory = Pick<
  SessionDirectoryRecord,
  | 'path'
  | 'kind'
  | 'repositoryId'
  | 'branch'
  | 'baseBranch'
  | 'state'
  | 'setupStatus'
>;

export interface NewSession {
  id: string;
  title: string | null;
  model: string | null;
  permissionMode: SessionPermissionMode;
  status: SessionStatus;
  slug: string | null;
  pendingMessage: { id: string; text: string } | null;
  directories: NewSessionDirectory[];
}

export type SessionPatch = Partial<
  Pick<
    SessionRecord,
    'sdkSessionId' | 'title' | 'status' | 'lastError' | 'pendingMessage'
  >
>;

export type SessionDirectoryPatch = Partial<
  Pick<
    SessionDirectoryRecord,
    'state' | 'setupStatus' | 'baseBranch' | 'baseCommit'
  >
>;

/** The working directory: path of the first directory. */
export function workingDirectory(record: SessionRecord): string {
  const first = record.directories[0];
  if (!first) {
    throw new Error(`Session ${record.id} has no directories`);
  }
  return first.path;
}

/** Paths of the directories after the first. */
export function additionalDirectories(record: SessionRecord): string[] {
  return record.directories.slice(1).map((directory) => directory.path);
}

@Injectable()
export class SessionRepository {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  /**
   * Creates a session with its directories (and the new project, if any) in
   * one transaction.
   */
  create(session: NewSession, now = new Date()): SessionRecord {
    const { directories, ...columns } = session;
    if (directories.length === 0) {
      throw new Error('A session needs at least one directory');
    }
    this.db.transaction((tx) => {
      tx.insert(sessions)
        .values({ ...columns, createdAt: now, updatedAt: now })
        .run();
      directories.forEach((directory, position) => {
        tx.insert(sessionDirectories)
          .values({ ...directory, sessionId: session.id, position })
          .run();
      });
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

  listByStatus(status: SessionStatus): SessionRecord[] {
    return this.withDirectories(
      this.db.select().from(sessions).where(eq(sessions.status, status)).all(),
    );
  }

  slugExists(slug: string): boolean {
    return (
      this.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.slug, slug))
        .get() !== undefined
    );
  }

  update(id: string, patch: SessionPatch, now = new Date()): SessionRecord {
    this.db
      .update(sessions)
      .set({ ...patch, updatedAt: now })
      .where(eq(sessions.id, id))
      .run();
    return this.require(id);
  }

  updateDirectory(
    sessionId: string,
    position: number,
    patch: SessionDirectoryPatch,
    now = new Date(),
  ): SessionRecord {
    this.db.transaction((tx) => {
      tx.update(sessionDirectories)
        .set(patch)
        .where(
          and(
            eq(sessionDirectories.sessionId, sessionId),
            eq(sessionDirectories.position, position),
          ),
        )
        .run();
      tx.update(sessions)
        .set({ updatedAt: now })
        .where(eq(sessions.id, sessionId))
        .run();
    });
    return this.require(sessionId);
  }

  /** Paths of all session clones that exist (state `ready`). */
  readyClonePaths(): string[] {
    return this.db
      .select({ path: sessionDirectories.path })
      .from(sessionDirectories)
      .where(
        and(
          eq(sessionDirectories.kind, 'clone'),
          eq(sessionDirectories.state, 'ready'),
        ),
      )
      .all()
      .map((row) => row.path);
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
      .select({
        sessionId: sessionDirectories.sessionId,
        position: sessionDirectories.position,
        path: sessionDirectories.path,
        kind: sessionDirectories.kind,
        repositoryId: sessionDirectories.repositoryId,
        owner: repositories.owner,
        name: repositories.name,
        cloneUrl: repositories.cloneUrl,
        branch: sessionDirectories.branch,
        baseBranch: sessionDirectories.baseBranch,
        baseCommit: sessionDirectories.baseCommit,
        state: sessionDirectories.state,
        setupStatus: sessionDirectories.setupStatus,
      })
      .from(sessionDirectories)
      .leftJoin(
        repositories,
        eq(repositories.id, sessionDirectories.repositoryId),
      )
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
      directories: directories
        .filter((directory) => directory.sessionId === row.id)
        .map(
          ({
            sessionId,
            owner,
            name,
            cloneUrl,
            ...directory
          }): SessionDirectoryRecord => {
            void sessionId;
            const known = owner !== null && name !== null;
            return {
              ...directory,
              repositoryName: known ? `${owner}/${name}` : null,
              repositoryLocal: known && cloneUrl === null,
            };
          },
        ),
    }));
  }
}
