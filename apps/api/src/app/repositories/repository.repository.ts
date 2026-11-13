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
  /** `null` for a local project without remote. */
  cloneUrl: string | null;
  localPath: string;
  setupScript: string | null;
  githubRepositoryId?: number | null;
  githubInstallationId?: number | null;
  defaultBranch?: string | null;
}

export type RepositoryPatch = Partial<
  Pick<
    RepositoryRecord,
    | 'defaultBranch'
    | 'setupScript'
    | 'clonedAt'
    | 'fetchedAt'
    | 'lastError'
    | 'owner'
    | 'name'
    | 'cloneUrl'
    | 'githubRepositoryId'
    | 'githubInstallationId'
  >
>;

/** A session's clone of a repository, as the database knows it. */
export interface CloneLink {
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

  findByGitHubId(githubRepositoryId: number): RepositoryRecord | undefined {
    return this.db
      .select()
      .from(repositories)
      .where(eq(repositories.githubRepositoryId, githubRepositoryId))
      .get();
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
   * Session clones that sessions use or are about to create (state
   * `pending` or `ready`), per repository.
   */
  cloneLinks(repositoryIds: string[]): Map<string, CloneLink[]> {
    const links = new Map<string, CloneLink[]>();
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
          eq(sessionDirectories.kind, 'clone'),
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

  /** Paths of scratch directories that sessions use or are about to create. */
  activeScratchPaths(): Set<string> {
    return new Set(
      this.db
        .select({ path: sessionDirectories.path })
        .from(sessionDirectories)
        .where(
          and(
            eq(sessionDirectories.kind, 'scratch'),
            inArray(sessionDirectories.state, ['pending', 'ready']),
          ),
        )
        .all()
        .map((row) => row.path),
    );
  }
}
