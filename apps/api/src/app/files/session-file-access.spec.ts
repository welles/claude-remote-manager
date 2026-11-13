import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAccessError, SessionFileAccess } from './session-file-access';

describe('SessionFileAccess', () => {
  let dir: string;
  let clone: string;
  let other: string;
  const access = new SessionFileAccess();

  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return 'ok';
    } catch (error) {
      return error instanceof FileAccessError ? error.code : String(error);
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crm-files-'));
    clone = join(dir, 'session', 'acme', 'tool');
    other = join(dir, 'session', 'acme', 'lib');
    mkdirSync(join(clone, 'docs'), { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(clone, 'docs', 'report.md'), '# Report\n');
    writeFileSync(join(other, 'lib.txt'), 'lib');
    writeFileSync(join(dir, 'secret.txt'), 'secret');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads files inside the session’s directories', async () => {
    const roots = [clone, other];
    const file = await access.read(roots, 'docs/report.md', 1000);
    expect(file).toMatchObject({
      path: join(clone, 'docs', 'report.md'),
      size: 9,
      truncated: false,
    });
    expect(file.data.toString()).toBe('# Report\n');
    // Absolute paths into another directory of the session.
    expect(
      (await access.read(roots, join(other, 'lib.txt'), 1000)).data.toString(),
    ).toBe('lib');
    // Larger files are read up to the limit.
    const part = await access.read(roots, 'docs/report.md', 4);
    expect(part).toMatchObject({ size: 9, truncated: true });
    expect(part.data.toString()).toBe('# Re');
    // Symlinks inside the directories are fine.
    symlinkSync(join(clone, 'docs', 'report.md'), join(clone, 'link.md'));
    expect((await access.read(roots, 'link.md', 100)).path).toBe(
      join(clone, 'docs', 'report.md'),
    );
  });

  it('refuses everything outside, and special files', async () => {
    const roots = [clone];
    symlinkSync(join(dir, 'secret.txt'), join(clone, 'escape.txt'));
    symlinkSync(dir, join(clone, 'up'));
    expect(await code(access.read(roots, 'escape.txt', 100))).toBe('outside');
    expect(await code(access.read(roots, 'up/secret.txt', 100))).toBe(
      'outside',
    );
    expect(await code(access.read(roots, '../../../secret.txt', 100))).toBe(
      'outside',
    );
    expect(await code(access.read(roots, join(dir, 'secret.txt'), 100))).toBe(
      'outside',
    );
    expect(await code(access.read(roots, '/etc/passwd', 100))).toBe('outside');
    // The other repository is not one of these roots.
    expect(await code(access.read(roots, join(other, 'lib.txt'), 100))).toBe(
      'outside',
    );
    expect(await code(access.read(roots, 'docs', 100))).toBe('not_regular');
    execFileSync('mkfifo', [join(clone, 'pipe')]);
    expect(await code(access.read(roots, 'pipe', 100))).toBe('not_regular');
    expect(await code(access.read(roots, 'missing.txt', 100))).toBe(
      'not_found',
    );
    // A missing file outside is "outside", not "not found".
    expect(await code(access.read(roots, '/nonexistent/x', 100))).toBe(
      'outside',
    );
    expect(await code(access.read([join(dir, 'gone')], 'x', 100))).toBe(
      'usage',
    );
  });

  it('lists files without .git and node_modules', async () => {
    mkdirSync(join(clone, '.git'));
    writeFileSync(join(clone, '.git', 'HEAD'), '');
    mkdirSync(join(clone, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(clone, 'node_modules', 'x', 'i.js'), '');
    writeFileSync(join(clone, 'odd name\twith tab.txt'), '');
    expect(await access.list(clone, 100)).toEqual({
      paths: ['docs/report.md', 'odd name\twith tab.txt'],
      truncated: false,
    });
    expect(await access.list(clone, 1)).toEqual({
      paths: ['docs/report.md'],
      truncated: true,
    });
  });
});
