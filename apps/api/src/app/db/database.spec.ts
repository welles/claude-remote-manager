import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATABASE_FILE_NAME, openDatabase } from './database';

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
      'session_directories',
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
        "INSERT INTO sessions (id, status, cwd, updated_at) VALUES ('s', 'finished', '/w', 0)",
      )
      .run();
    first.$client.close();

    const second = openDatabase(dir);
    expect(
      second.$client.prepare('SELECT id, permission_mode FROM sessions').all(),
    ).toEqual([{ id: 's', permission_mode: 'default' }]);
    second.$client.close();
  });
});
