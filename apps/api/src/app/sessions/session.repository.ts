import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
} from 'drizzle-orm';
import type {
  PullRequestCreator,
  PullRequestChecksDto,
  PullRequestState,
  RepositoryAddedBy,
  RepositoryAdditionState,
  SessionDirectoryKind,
  SessionDirectoryState,
  SessionPermissionMode,
  SessionStatus,
  SessionTitleSource,
  SetupStatus,
} from '@claude-remote-manager/shared-types';
import { DATABASE, type AppDatabase } from '../db/database';
import {
  deletedSessions,
  pullRequests,
  repositories,
  sessionDirectories,
  sessions,
  type PullRequestRow,
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
  /** The repository is registered from GitHub. */
  repositoryGitHub: boolean;
  branch: string | null;
  baseBranch: string | null;
  baseCommit: string | null;
  state: SessionDirectoryState;
  setupStatus: SetupStatus;
  pushedCommit: string | null;
  pushedAt: Date | null;
  /** Set for a repository added while the session ran. */
  addition: DirectoryAddition | null;
}

/** How a repository was added to a running session (see the schema). */
export interface DirectoryAddition {
  addedAt: Date;
  by: RepositoryAddedBy;
  state: RepositoryAdditionState;
  error: string | null;
  /** Claude still has to be told about it (with the next message). */
  announce: boolean;
}

/** A pull request of a session clone, see `pull_requests`. */
export interface PullRequestRecord extends PullRequestRow {
  /** `owner/name` of the repository. */
  repositoryName: string;
}

export type NewPullRequest = {
  sessionId: string;
  repositoryId: string;
  number: number;
  url: string;
  title: string;
  state: PullRequestState;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  headSha?: string | null;
  createdBy: PullRequestCreator;
  openedAt: Date;
  closedAt: Date | null;
  mergedAt: Date | null;
  syncedAt: Date;
};

export type PullRequestPatch = Partial<
  Pick<
    NewPullRequest,
    | 'title'
    | 'state'
    | 'draft'
    | 'baseBranch'
    | 'closedAt'
    | 'mergedAt'
    | 'syncedAt'
  > &
    Pick<
      PullRequestRow,
      | 'headSha'
      | 'autofix'
      | 'autoclose'
      | 'autofixMaxAttempts'
      | 'autofixAttempts'
      | 'autofixGaveUpAt'
      | 'autofixCiHandledSha'
      | 'autofixReadySha'
      | 'autofixReviewsAfter'
      | 'autofixLastRunAt'
      | 'autofixLastTrigger'
      | 'autofixRunning'
      | 'closeHandledAt'
      | 'automerge'
      | 'automergeHeldAt'
      | 'automergeHoldReason'
      | 'automergeFailedSha'
      | 'automergeFailure'
      | 'automergeWaiting'
      | 'automergeNotifiedSha'
    >
>;

/** A session's persisted metadata. */
export interface SessionRecord {
  id: string;
  sdkSessionId: string | null;
  title: string | null;
  /** Where the title comes from (see `sessions.title_source`). */
  titleSource: SessionTitleSource;
  model: string | null;
  permissionMode: SessionPermissionMode;
  status: SessionStatus;
  slug: string | null;
  pendingMessage: { id: string; text: string } | null;
  /** In order; the first is the working directory. */
  directories: SessionDirectoryRecord[];
  /** Pull requests of the session's clones, oldest first. */
  pullRequests: PullRequestRecord[];
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** When autoclose ended the session (see `sessions.autoclosed_at`). */
  autoclosedAt: Date | null;
  /** When the session was archived; `null` while it is not. */
  archivedAt: Date | null;
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
  titleSource?: SessionTitleSource;
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
    | 'sdkSessionId'
    | 'title'
    | 'titleSource'
    | 'status'
    | 'lastError'
    | 'pendingMessage'
    | 'model'
    | 'permissionMode'
    | 'autoclosedAt'
    | 'archivedAt'
  >
>;

export type SessionDirectoryPatch = Partial<
  Pick<
    SessionDirectoryRecord,
    | 'state'
    | 'setupStatus'
    | 'baseBranch'
    | 'baseCommit'
    | 'pushedCommit'
    | 'pushedAt'
  > & {
    additionState: RepositoryAdditionState;
    additionError: string | null;
    announce: boolean;
  }
>;

/** A repository added to a running session, before it is prepared. */
export type NewAddedDirectory = Pick<
  SessionDirectoryRecord,
  'path' | 'repositoryId' | 'branch' | 'baseBranch' | 'setupStatus'
> & { addedBy: RepositoryAddedBy };

/**
 * Whether Claude works in the directory: every directory the session
 * started with, and added repositories once they are ready (not while
 * they are prepared, failed or held after a failed setup script).
 */
export function isActiveDirectory(directory: SessionDirectoryRecord): boolean {
  return !directory.addition || directory.addition.state === 'ready';
}

/** The working directory: path of the first directory. */
export function workingDirectory(record: SessionRecord): string {
  const first = record.directories[0];
  if (!first) {
    throw new Error(`Session ${record.id} has no directories`);
  }
  return first.path;
}

/**
 * Paths of the directories after the first that Claude works in (added
 * repositories only once they are ready, see {@link isActiveDirectory}).
 */
export function additionalDirectories(record: SessionRecord): string[] {
  return record.directories
    .slice(1)
    .filter(isActiveDirectory)
    .map((directory) => directory.path);
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

  /**
   * Sessions, most recently updated first: all, or only those that are
   * (`only`) or are not (`exclude`) archived.
   */
  list(archived: 'include' | 'only' | 'exclude' = 'include'): SessionRecord[] {
    const rows = this.db
      .select()
      .from(sessions)
      .where(
        archived === 'only'
          ? isNotNull(sessions.archivedAt)
          : archived === 'exclude'
            ? isNull(sessions.archivedAt)
            : undefined,
      )
      .orderBy(desc(sessions.updatedAt), desc(sessions.createdAt))
      .all();
    return this.withDirectories(rows);
  }

  /** Paths of all directories of all sessions except one. */
  directoryPathsExcept(sessionId: string): string[] {
    return this.db
      .select({ path: sessionDirectories.path })
      .from(sessionDirectories)
      .where(ne(sessionDirectories.sessionId, sessionId))
      .all()
      .map((row) => row.path);
  }

  /**
   * Deletes a session with everything the database cascades to (its
   * directories, events, pull requests, attachments, shown files, search
   * documents), keeping its usage records, and notes in
   * `deleted_sessions` what it was, so the usage stays attributable.
   */
  delete(id: string, now = new Date()): void {
    const record = this.require(id);
    this.db.transaction((tx) => {
      tx.insert(deletedSessions)
        .values({
          id,
          title: record.title,
          repositories: record.directories.flatMap((directory) =>
            directory.repositoryName ? [directory.repositoryName] : [],
          ),
          createdAt: record.createdAt,
          deletedAt: now,
        })
        .onConflictDoNothing()
        .run();
      tx.delete(sessions).where(eq(sessions.id, id)).run();
    });
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

  /**
   * Adds a repository's clone to a session that exists already, after its
   * other directories (state `pending`, addition `preparing`). Fails on the
   * unique index when the repository is part of the session already.
   */
  addDirectory(
    sessionId: string,
    directory: NewAddedDirectory,
    now = new Date(),
  ): SessionDirectoryRecord {
    let position = 0;
    this.db.transaction((tx) => {
      const last = tx
        .select({ position: sessionDirectories.position })
        .from(sessionDirectories)
        .where(eq(sessionDirectories.sessionId, sessionId))
        .orderBy(desc(sessionDirectories.position))
        .get();
      position = (last?.position ?? -1) + 1;
      tx.insert(sessionDirectories)
        .values({
          sessionId,
          position,
          path: directory.path,
          kind: 'clone',
          repositoryId: directory.repositoryId,
          branch: directory.branch,
          baseBranch: directory.baseBranch,
          state: 'pending',
          setupStatus: directory.setupStatus,
          addedAt: now,
          addedBy: directory.addedBy,
          additionState: 'preparing',
        })
        .run();
      tx.update(sessions)
        .set({ updatedAt: now })
        .where(eq(sessions.id, sessionId))
        .run();
    });
    return this.require(sessionId).directories.find(
      (entry) => entry.position === position,
    ) as SessionDirectoryRecord;
  }

  /**
   * Forgets a directory that was added to a running session and never
   * became part of it (its clone is removed first). Only additions.
   */
  deleteAddedDirectory(
    sessionId: string,
    position: number,
    now = new Date(),
  ): void {
    this.db.transaction((tx) => {
      tx.delete(sessionDirectories)
        .where(
          and(
            eq(sessionDirectories.sessionId, sessionId),
            eq(sessionDirectories.position, position),
            isNotNull(sessionDirectories.addedAt),
          ),
        )
        .run();
      tx.update(sessions)
        .set({ updatedAt: now })
        .where(eq(sessions.id, sessionId))
        .run();
    });
  }

  /** Added directories still being prepared (cut off by a server stop). */
  preparingAdditions(): { sessionId: string; position: number }[] {
    return this.db
      .select({
        sessionId: sessionDirectories.sessionId,
        position: sessionDirectories.position,
      })
      .from(sessionDirectories)
      .where(eq(sessionDirectories.additionState, 'preparing'))
      .all();
  }

  /**
   * Stores a pull request of a session clone; one that is known already
   * (same repository and number) is updated instead, keeping its creator
   * and session.
   */
  savePullRequest(pull: NewPullRequest): PullRequestRecord {
    const { sessionId, repositoryId, number, createdBy, ...state } = pull;
    this.db
      .insert(pullRequests)
      .values({ sessionId, repositoryId, number, createdBy, ...state })
      .onConflictDoUpdate({
        target: [pullRequests.repositoryId, pullRequests.number],
        set: state,
      })
      .run();
    this.touch(sessionId);
    const saved = this.db
      .select({ sessionId: pullRequests.sessionId })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          eq(pullRequests.number, number),
        ),
      )
      .get();
    return this.pullRequestsOf([saved?.sessionId ?? sessionId]).find(
      (entry) => entry.repositoryId === repositoryId && entry.number === number,
    ) as PullRequestRecord;
  }

  /**
   * Changes a pull request; `touch: false` leaves the session's
   * `updatedAt` (its place in the list) alone.
   */
  updatePullRequest(
    id: number,
    patch: PullRequestPatch,
    { touch = true }: { touch?: boolean } = {},
  ): void {
    const row = this.db
      .update(pullRequests)
      .set(patch)
      .where(eq(pullRequests.id, id))
      .returning({ sessionId: pullRequests.sessionId })
      .get();
    if (row && touch) {
      this.touch(row.sessionId);
    }
  }

  /**
   * Stores the checks read for a pull request's head commit. Unlike
   * {@link updatePullRequest} it leaves the session's `updatedAt` alone:
   * CI progress does not move a session up the list.
   */
  setPullRequestChecks(id: number, checks: PullRequestChecksDto): void {
    this.db
      .update(pullRequests)
      .set({ checks })
      .where(eq(pullRequests.id, id))
      .run();
  }

  /** A pull request by its ID. */
  pullRequest(id: number): PullRequestRecord | undefined {
    return this.pullRequestsWhere(eq(pullRequests.id, id))[0];
  }

  /** Open pull requests with autofix or autoclose on, oldest first. */
  automatedOpenPullRequests(): PullRequestRecord[] {
    return this.pullRequestsWhere(
      and(
        eq(pullRequests.state, 'open'),
        or(eq(pullRequests.autofix, true), eq(pullRequests.autoclose, true)),
      ),
    );
  }

  /**
   * Pull requests of the repository with this GitHub ID, all or those with
   * the given numbers.
   */
  pullRequestsOfGitHubRepository(
    githubRepositoryId: number,
    numbers?: number[],
  ): PullRequestRecord[] {
    return this.pullRequestsWhere(
      and(
        eq(repositories.githubRepositoryId, githubRepositoryId),
        numbers ? inArray(pullRequests.number, numbers) : undefined,
      ),
    );
  }

  /** After a restart no autofix run is going on any more. */
  clearAutofixRunning(): void {
    this.db
      .update(pullRequests)
      .set({ autofixRunning: false })
      .where(eq(pullRequests.autofixRunning, true))
      .run();
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

  private touch(sessionId: string, now = new Date()): void {
    this.db
      .update(sessions)
      .set({ updatedAt: now })
      .where(eq(sessions.id, sessionId))
      .run();
  }

  private pullRequestsOf(sessionIds: string[]): PullRequestRecord[] {
    if (sessionIds.length === 0) {
      return [];
    }
    return this.pullRequestsWhere(inArray(pullRequests.sessionId, sessionIds));
  }

  private pullRequestsWhere(where: SQL | undefined): PullRequestRecord[] {
    return this.db
      .select({
        pull: pullRequests,
        owner: repositories.owner,
        name: repositories.name,
      })
      .from(pullRequests)
      .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
      .where(where)
      .orderBy(asc(pullRequests.openedAt), asc(pullRequests.id))
      .all()
      .map(({ pull, owner, name }) => ({
        ...pull,
        repositoryName: `${owner}/${name}`,
      }));
  }

  private withDirectories(rows: SessionRow[]): SessionRecord[] {
    if (rows.length === 0) {
      return [];
    }
    const pulls = this.pullRequestsOf(rows.map((row) => row.id));
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
        githubRepositoryId: repositories.githubRepositoryId,
        branch: sessionDirectories.branch,
        baseBranch: sessionDirectories.baseBranch,
        baseCommit: sessionDirectories.baseCommit,
        state: sessionDirectories.state,
        setupStatus: sessionDirectories.setupStatus,
        pushedCommit: sessionDirectories.pushedCommit,
        pushedAt: sessionDirectories.pushedAt,
        addedAt: sessionDirectories.addedAt,
        addedBy: sessionDirectories.addedBy,
        additionState: sessionDirectories.additionState,
        additionError: sessionDirectories.additionError,
        announce: sessionDirectories.announce,
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
      pullRequests: pulls.filter((pull) => pull.sessionId === row.id),
      directories: directories
        .filter((directory) => directory.sessionId === row.id)
        .map(
          ({
            sessionId,
            owner,
            name,
            cloneUrl,
            githubRepositoryId,
            addedAt,
            addedBy,
            additionState,
            additionError,
            announce,
            ...directory
          }): SessionDirectoryRecord => {
            void sessionId;
            const known = owner !== null && name !== null;
            return {
              ...directory,
              repositoryName: known ? `${owner}/${name}` : null,
              repositoryLocal: known && cloneUrl === null,
              repositoryGitHub: known && githubRepositoryId !== null,
              addition: addedAt
                ? {
                    addedAt,
                    by: addedBy ?? 'user',
                    state: additionState ?? 'ready',
                    error: additionError,
                    announce,
                  }
                : null,
            };
          },
        ),
    }));
  }
}
