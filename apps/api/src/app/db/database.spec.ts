import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRepository } from '../sessions/session.repository';
import { DATABASE_FILE_NAME, MIGRATIONS_DIR, openDatabase } from './database';

describe('openDatabase', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crm-db-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const tables = (db: ReturnType<typeof openDatabase>) =>
    (
      db.$client
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);

  it('creates the directory and file and applies the migrations', () => {
    const location = join(dir, 'nested', 'db');
    const db = openDatabase(location);

    expect(existsSync(join(location, DATABASE_FILE_NAME))).toBe(true);
    expect(tables(db)).toEqual([
      'app_settings',
      'attachments',
      'deleted_sessions',
      'environment_entries',
      'environments',
      'message_contexts',
      'previews',
      'pull_requests',
      'push_subscriptions',
      'repositories',
      'search_documents',
      'search_index',
      'search_index_config',
      'search_index_data',
      'search_index_docsize',
      'search_index_idx',
      'search_sessions',
      'session_directories',
      'session_events',
      'sessions',
      'shown_files',
      'usage_records',
      'webhook_deliveries',
    ]);
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
    db.$client.close();
  });

  it('keeps data and skips applied migrations when opened again', () => {
    const first = openDatabase(dir);
    first.$client
      .prepare(
        "INSERT INTO sessions (id, status, updated_at) VALUES ('s', 'finished', 0)",
      )
      .run();
    first.$client.close();

    const second = openDatabase(dir);
    expect(
      second.$client.prepare('SELECT id, permission_mode FROM sessions').all(),
    ).toEqual([{ id: 's', permission_mode: 'default' }]);
    second.$client.close();
  });

  /** Migrations up to and including the given number (a copy). */
  const migrationsUpTo = (last: number) => {
    const target = join(dir, `migrations-${last}`);
    cpSync(MIGRATIONS_DIR, target, { recursive: true });
    const journalFile = join(target, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= last);
    writeFileSync(journalFile, JSON.stringify(journal));
    return target;
  };

  it('moves the working directory of existing sessions into their directories', () => {
    const old = openDatabase(dir, migrationsUpTo(1));
    const run = (sql: string) => old.$client.prepare(sql).run();
    run(
      "INSERT INTO sessions (id, sdk_session_id, title, status, cwd, updated_at) VALUES ('a', 'sdk-a', 'A', 'waiting', '/scratch', 1), ('b', NULL, 'B', 'finished', '/other', 2)",
    );
    run(
      "INSERT INTO session_directories (session_id, position, path) VALUES ('a', 0, '/extra/one'), ('a', 1, '/extra/two')",
    );
    run(
      "INSERT INTO usage_records (session_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd) VALUES ('a', 'haiku', 1, 2, 3, 4, 0.5)",
    );
    run(
      "INSERT INTO session_events (session_id, type, payload) VALUES ('a', 'notice', '{}')",
    );
    old.$client.close();

    const db = openDatabase(dir);
    const sessions = new SessionRepository(db);
    const a = sessions.require('a');
    expect(a).toMatchObject({
      sdkSessionId: 'sdk-a',
      title: 'A',
      status: 'waiting',
      slug: null,
      pendingMessage: null,
    });
    expect(a.directories).toEqual(
      ['/scratch', '/extra/one', '/extra/two'].map((path, position) => ({
        position,
        path,
        kind: 'directory',
        repositoryId: null,
        repositoryName: null,
        repositoryLocal: false,
        repositoryGitHub: false,
        branch: null,
        baseBranch: null,
        baseCommit: null,
        state: 'ready',
        setupStatus: 'none',
        pushedCommit: null,
        pushedAt: null,
        addition: null,
      })),
    );
    expect(sessions.require('b').directories.map((d) => d.path)).toEqual([
      '/other',
    ]);
    const count = (table: string) =>
      (
        db.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n;
    expect(count('usage_records')).toBe(1);
    expect(count('session_events')).toBe(1);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
    db.$client.close();
  });

  it('keeps usage records when their session is deleted (migration 0011)', () => {
    const old = openDatabase(dir, migrationsUpTo(10));
    const run = (sql: string) => old.$client.prepare(sql).run();
    run(
      "INSERT INTO sessions (id, title, status, updated_at) VALUES ('a', 'A', 'finished', 1)",
    );
    run(
      "INSERT INTO usage_records (session_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd) VALUES ('a', 'haiku', 1, 2, 3, 4, 0.5)",
    );
    old.$client.close();

    const db = openDatabase(dir);
    db.$client.prepare("DELETE FROM sessions WHERE id = 'a'").run();
    expect(
      db.$client
        .prepare('SELECT session_id, cost_usd FROM usage_records')
        .all(),
    ).toEqual([{ session_id: 'a', cost_usd: 0.5 }]);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
    db.$client.close();
  });

  it('records closes earlier versions left unhandled, except those autoclose still has to handle (migration 0020)', () => {
    const old = openDatabase(dir, migrationsUpTo(19));
    const run = (sql: string) => old.$client.prepare(sql).run();
    run(
      "INSERT INTO repositories (id, owner, name, local_path, updated_at) VALUES ('r', 'acme', 'app', '/repos/acme/app', 1)",
    );
    // a: old merged PR next to an open one; b: autoclose due (all closed);
    // c: autoclosed already; d: handled already.
    run(
      "INSERT INTO sessions (id, status, updated_at, autoclosed_at) VALUES ('a', 'waiting', 1, NULL), ('b', 'waiting', 1, NULL), ('c', 'finished', 1, 5), ('d', 'waiting', 1, NULL)",
    );
    const pull = (
      id: number,
      session: string,
      state: string,
      autoclose: number,
      handled: number | null,
    ) =>
      run(
        `INSERT INTO pull_requests (id, session_id, repository_id, number, url, title, state, head_branch, base_branch, created_by, opened_at, synced_at, autoclose, close_handled_at) VALUES (${id}, '${session}', 'r', ${id}, 'u', 't', '${state}', 'h${id}', 'main', 'user', 1, 1, ${autoclose}, ${handled ?? 'NULL'})`,
      );
    pull(1, 'a', 'merged', 0, null);
    pull(2, 'a', 'open', 1, null);
    pull(3, 'b', 'merged', 1, null);
    pull(4, 'b', 'closed', 0, null);
    pull(5, 'c', 'merged', 1, null);
    pull(6, 'd', 'merged', 0, 42);
    old.$client.close();

    const db = openDatabase(dir);
    const handled = Object.fromEntries(
      (
        db.$client
          .prepare('SELECT id, close_handled_at FROM pull_requests')
          .all() as { id: number; close_handled_at: number | null }[]
      ).map((row) => [row.id, row.close_handled_at]),
    );
    expect(handled[1]).toEqual(expect.any(Number));
    expect(handled[1]).toBeGreaterThan(1_700_000_000_000);
    expect(handled[2]).toBeNull();
    expect(handled[3]).toBeNull();
    expect(handled[4]).toBeNull();
    expect(handled[5]).toEqual(expect.any(Number));
    expect(handled[6]).toBe(42);
    db.$client.close();
  });

  it('keeps the full-text index in step with the search documents', () => {
    const db = openDatabase(dir);
    const run = (sql: string) => db.$client.prepare(sql).run();
    run(
      "INSERT INTO sessions (id, status, updated_at) VALUES ('a', 'finished', 1)",
    );
    run(
      "INSERT INTO search_documents (session_id, kind, anchor, hash, text, folded) VALUES ('a', 'user', 'm1', 'h', 'Fix the Größe', 'fix the größe')",
    );
    const hits = () =>
      db.$client
        .prepare(
          "SELECT d.anchor FROM search_index JOIN search_documents d ON d.id = search_index.rowid WHERE search_index.folded LIKE '%größe%'",
        )
        .all();
    expect(hits()).toEqual([{ anchor: 'm1' }]);
    // Deleting the session removes its documents and their index entries.
    run("DELETE FROM sessions WHERE id = 'a'");
    expect(hits()).toEqual([]);
    expect(
      db.$client
        .prepare(
          "SELECT count(*) AS n FROM search_index WHERE search_index MATCH 'größe'",
        )
        .get(),
    ).toEqual({ n: 0 });
    db.$client.close();
  });
});
