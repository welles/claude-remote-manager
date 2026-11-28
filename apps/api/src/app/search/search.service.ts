import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type {
  SearchHit,
  SearchMatch,
  SearchResponse,
  SessionEventInput,
} from '@claude-remote-manager/shared-types';
import { TranscriptReader } from '../agent/transcript-reader';
import { AgentEngines } from '../agent/agent-engines';
import { DATABASE, type AppDatabase } from '../db/database';
import { searchDocuments, searchSessions } from '../db/schema';
import {
  SessionRepository,
  type SessionRecord,
  transcriptDirectory,
} from '../sessions/session.repository';
import { SessionsService } from '../sessions/sessions.service';
import {
  foldText,
  likePattern,
  matchesAll,
  queryTerms,
  snippet,
} from './search-text';

/** Delay of the startup indexing after the module started. */
export const RECONCILE_DELAY_MS = 2000;
/** Most sessions in an answer. */
export const MAX_HITS = 50;
/** Most matches shown per session. */
export const MATCHES_PER_HIT = 3;
/** Most conversation documents read for one query. */
export const MAX_DOCUMENTS = 1000;

interface IndexedDocument {
  kind: 'user' | 'assistant';
  anchor: string;
  text: string;
}

/** The conversation documents of an event, if it is one. */
export function documentOf(event: SessionEventInput): IndexedDocument | null {
  if (event.type === 'user.message' && event.text.trim()) {
    return { kind: 'user', anchor: event.id, text: event.text };
  }
  if (
    event.type === 'assistant.text' &&
    event.parentToolUseId === null &&
    event.text.trim()
  ) {
    return { kind: 'assistant', anchor: event.messageId, text: event.text };
  }
  return null;
}

const hash = (text: string) => createHash('sha1').update(text).digest('hex');

/**
 * Full-text search over sessions.
 *
 * Titles, repository names and branches are matched directly in the
 * sessions' metadata (they are few). The conversation lives in Claude
 * Code's transcripts and the app's stored events, and the session history
 * is rebuilt from both; the index (`search_documents` with the FTS5 table
 * `search_index`, trigram tokenizer) is kept equal to that history:
 *
 * - whenever a session's history is built (the session is opened, or a
 *   message is sent to it), the session's entries are replaced by what the
 *   history holds; an unreadable transcript leaves them as they are;
 * - while a session runs, every user message and complete text block of
 *   Claude's is added as it arrives;
 * - at startup, every session whose transcript changed or disappeared
 *   while the server was down (size and modification time differ from
 *   when it was indexed) is indexed again from its history;
 * - deleting a session deletes its entries (database cascade).
 *
 * Queries are plain words: every word must occur in the same message
 * (any case, also inside words); `LIKE` patterns with escaped wildcards,
 * never FTS query syntax, so no input is a syntax error.
 */
@Injectable()
export class SearchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SearchService.name);
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reconciling: Promise<void> | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: AppDatabase,
    private readonly sessions: SessionsService,
    private readonly records: SessionRepository,
    private readonly transcripts: TranscriptReader,
    @Optional() private readonly engines?: AgentEngines,
  ) {}

  onModuleInit(): void {
    this.sessions.historyLoaded = (sessionId, events, transcript) => {
      if (transcript) {
        this.replace(sessionId, events);
        void this.noteSource(sessionId);
      }
    };
    this.sessions.eventAppended = (sessionId, event) =>
      this.add(sessionId, event);
    // Startup work runs after the server is up.
    this.timer = setTimeout(() => {
      this.reconciling = this.reconcile().then(
        () => undefined,
        (error: unknown) =>
          this.logger.warn(`Indexing sessions failed: ${String(error)}`),
      );
    }, RECONCILE_DELAY_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    await this.reconciling;
  }

  /** Adds a conversation event of a session to the index. */
  add(sessionId: string, event: SessionEventInput): void {
    const document = documentOf(event);
    if (!document) {
      return;
    }
    try {
      this.insert(sessionId, [document]);
    } catch (error) {
      this.logger.warn(`Indexing ${sessionId} failed: ${String(error)}`);
    }
  }

  /** Replaces the session's entries by the documents of its history. */
  replace(sessionId: string, events: readonly SessionEventInput[]): void {
    const documents = events
      .map(documentOf)
      .filter((document): document is IndexedDocument => document !== null);
    try {
      this.db.transaction((tx) => {
        tx.delete(searchDocuments)
          .where(eq(searchDocuments.sessionId, sessionId))
          .run();
        this.insert(sessionId, documents, tx);
      });
    } catch (error) {
      this.logger.warn(`Indexing ${sessionId} failed: ${String(error)}`);
    }
  }

  /**
   * Indexes every session whose transcript changed since it was indexed
   * (or that was never indexed), one after another.
   */
  async reconcile(): Promise<number> {
    let indexed = 0;
    for (const record of this.records.list('include')) {
      if (this.stopped) {
        break;
      }
      try {
        const source = await this.source(record);
        const known = this.db
          .select({ source: searchSessions.source })
          .from(searchSessions)
          .where(eq(searchSessions.sessionId, record.id))
          .get();
        if (known?.source === source) {
          continue;
        }
        const history = await this.sessions.historyEvents(record.id);
        if (!history.transcript || !this.records.get(record.id)) {
          continue;
        }
        this.replace(record.id, history.events);
        this.saveSource(record.id, source);
        indexed++;
      } catch (error) {
        this.logger.warn(`Indexing ${record.id} failed: ${String(error)}`);
      }
    }
    if (indexed > 0) {
      this.logger.log(`Indexed ${indexed} session(s) for the search`);
    }
    return indexed;
  }

  /** Searches titles, repositories, branches and conversations. */
  search(query: unknown): SearchResponse {
    const text = typeof query === 'string' ? query : '';
    const terms = queryTerms(text);
    if (terms.length === 0) {
      return { query: text, hits: [], truncated: false };
    }
    const sessions = new Map(
      this.records.list('include').map((record) => [record.id, record]),
    );
    const hits = new Map<
      string,
      { record: SessionRecord; matches: SearchMatch[]; meta: boolean }
    >();
    const hitFor = (record: SessionRecord) => {
      let hit = hits.get(record.id);
      if (!hit) {
        hit = { record, matches: [], meta: false };
        hits.set(record.id, hit);
      }
      return hit;
    };
    for (const record of sessions.values()) {
      const repositories = repositoryNames(record);
      const branches = [
        ...new Set(
          record.directories.flatMap((directory) =>
            directory.branch ? [directory.branch] : [],
          ),
        ),
      ];
      const metadata = [record.title ?? '', ...repositories, ...branches].join(
        '\n',
      );
      if (!matchesAll(metadata, terms)) {
        continue;
      }
      const hit = hitFor(record);
      hit.meta = true;
      const candidates: [SearchMatch['kind'], string][] = [
        ['title', record.title ?? ''],
        ...repositories.map((name): [SearchMatch['kind'], string] => [
          'repository',
          name,
        ]),
        ...branches.map((name): [SearchMatch['kind'], string] => [
          'branch',
          name,
        ]),
      ];
      for (const [kind, value] of candidates) {
        if (value && terms.some((term) => foldText(value).includes(term))) {
          hit.matches.push(snippet(kind, value, terms));
        }
      }
    }
    const rows = this.db.$client
      .prepare(
        `SELECT d.session_id AS sessionId, d.kind AS kind, d.anchor AS anchor, d.text AS text
           FROM search_index JOIN search_documents d ON d.id = search_index.rowid
          WHERE ${terms.map(() => "search_index.folded LIKE ? ESCAPE '\\'").join(' AND ')}
          ORDER BY d.id DESC
          LIMIT ?`,
      )
      .all(...terms.map(likePattern), MAX_DOCUMENTS + 1) as {
      sessionId: string;
      kind: 'user' | 'assistant';
      anchor: string;
      text: string;
    }[];
    const truncatedDocuments = rows.length > MAX_DOCUMENTS;
    for (const row of rows.slice(0, MAX_DOCUMENTS).reverse()) {
      const record = sessions.get(row.sessionId);
      if (record) {
        hitFor(record).matches.push(
          snippet(row.kind, row.text, terms, row.anchor),
        );
      }
    }
    const ordered = [...hits.values()].sort(
      (a, b) =>
        Number(b.meta) - Number(a.meta) ||
        b.record.updatedAt.getTime() - a.record.updatedAt.getTime(),
    );
    return {
      query: text,
      hits: ordered.slice(0, MAX_HITS).map(
        ({ record, matches }): SearchHit => ({
          sessionId: record.id,
          title: record.title,
          status: record.status,
          archivedAt: record.archivedAt?.toISOString() ?? null,
          updatedAt: record.updatedAt.toISOString(),
          repositories: repositoryNames(record),
          matches: matches.slice(0, MATCHES_PER_HIT),
          matchCount: matches.length,
        }),
      ),
      truncated: truncatedDocuments || ordered.length > MAX_HITS,
    };
  }

  // -------------------------------------------------------------------------

  private insert(
    sessionId: string,
    documents: IndexedDocument[],
    tx: Pick<AppDatabase, 'insert'> = this.db,
  ): void {
    if (documents.length === 0) {
      return;
    }
    const rows = documents.map((document) => ({
      sessionId,
      kind: document.kind,
      anchor: document.anchor,
      hash: hash(document.text),
      text: document.text,
      folded: foldText(document.text),
    }));
    // SQLite limits the variables per statement.
    for (let index = 0; index < rows.length; index += 100) {
      tx.insert(searchDocuments)
        .values(rows.slice(index, index + 100))
        .onConflictDoNothing()
        .run();
    }
  }

  /** What the index of a session is built from (see `search_sessions`). */
  private async source(record: SessionRecord): Promise<string> {
    const cwd = transcriptDirectory(record);
    const id = record.sdkSessionId ?? record.id;
    const stamp = cwd
      ? await (this.engines?.transcripts(record.engine) ?? this.transcripts).stamp(
          id,
          cwd,
          record.workingDirectory !== null,
        )
      : null;
    return stamp ?? 'missing';
  }

  private async noteSource(sessionId: string): Promise<void> {
    const record = this.records.get(sessionId);
    if (!record) {
      return;
    }
    try {
      this.saveSource(sessionId, await this.source(record));
    } catch {
      // The next start indexes it again.
    }
  }

  private saveSource(sessionId: string, source: string): void {
    if (!this.records.get(sessionId)) {
      return;
    }
    this.db
      .insert(searchSessions)
      .values({ sessionId, source, indexedAt: new Date() })
      .onConflictDoUpdate({
        target: searchSessions.sessionId,
        set: { source, indexedAt: new Date() },
      })
      .run();
  }
}

function repositoryNames(record: SessionRecord): string[] {
  return record.directories.flatMap((directory) =>
    directory.repositoryName ? [directory.repositoryName] : [],
  );
}
