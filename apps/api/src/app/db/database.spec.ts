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
      'repositories',
      'session_directories',
      'session_events',
      'sessions',
      'usage_records',
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
        branch: null,
        baseBranch: null,
        baseCommit: null,
        state: 'ready',
        setupStatus: 'none',
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
});
