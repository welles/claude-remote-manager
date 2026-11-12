import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DATABASE, type AppDatabase } from '../db/database';
import {
  repositories,
  sessionDirectories,
  sessions,
  type RepositoryRow,
} from '../db/schema';

export type RepositoryRecord = RepositoryRow;

export interface NewRepository {
  id: string;
  owner: string;
  name: string;
  cloneUrl: string;
  localPath: string;
  setupScript: string | null;
}

export type RepositoryPatch = Partial<
  Pick<
    RepositoryRecord,
    'defaultBranch' | 'setupScript' | 'clonedAt' | 'fetchedAt' | 'lastError'
  >
>;

/** A session's worktree of a repository, as the database knows it. */
export interface WorktreeLink {
  path: string;
  branch: string | null;
  sessionId: string;
  sessionTitle: string | null;
}

@Injectable()
export class RepositoryRepository {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  create(repository: NewRepository, now = new Date()): RepositoryRecord {
    this.db
      .insert(repositories)
      .values({ ...repository, createdAt: now, updatedAt: now })
      .run();
    return this.require(repository.id);
  }

  get(id: string): RepositoryRecord | undefined {
    return this.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, id))
      .get();
  }

  require(id: string): RepositoryRecord {
    const record = this.get(id);
    if (!record) {
      throw new Error(`Repository ${id} not found`);
    }
    return record;
  }

  /** All repositories by owner and name. */
  list(): RepositoryRecord[] {
    return this.db
      .select()
      .from(repositories)
      .orderBy(asc(repositories.owner), asc(repositories.name))
      .all();
  }

  /** Repository with this owner and name, ignoring case as GitHub does. */
  findByName(owner: string, name: string): RepositoryRecord | undefined {
    const wanted = `${owner}/${name}`.toLowerCase();
    return this.list().find(
      (record) => `${record.owner}/${record.name}`.toLowerCase() === wanted,
    );
  }

  update(
    id: string,
    patch: RepositoryPatch,
    now = new Date(),
  ): RepositoryRecord {
    this.db
      .update(repositories)
      .set({ ...patch, updatedAt: now })
      .where(eq(repositories.id, id))
      .run();
    return this.require(id);
  }

  /**
   * Worktrees that sessions use or are about to create (state `pending` or
   * `ready`), per repository.
   */
  worktreeLinks(repositoryIds: string[]): Map<string, WorktreeLink[]> {
    const links = new Map<string, WorktreeLink[]>();
    if (repositoryIds.length === 0) {
      return links;
    }
    const rows = this.db
      .select({
        repositoryId: sessionDirectories.repositoryId,
        path: sessionDirectories.path,
        branch: sessionDirectories.branch,
        sessionId: sessionDirectories.sessionId,
        sessionTitle: sessions.title,
      })
      .from(sessionDirectories)
      .innerJoin(sessions, eq(sessions.id, sessionDirectories.sessionId))
      .where(
        and(
          inArray(sessionDirectories.repositoryId, repositoryIds),
          inArray(sessionDirectories.state, ['pending', 'ready']),
        ),
      )
      .all();
    for (const { repositoryId, ...link } of rows) {
      if (repositoryId) {
        links.set(repositoryId, [...(links.get(repositoryId) ?? []), link]);
      }
    }
    return links;
  }
}
