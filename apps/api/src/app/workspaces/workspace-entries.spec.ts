import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../config/app-config';
import {
  checkLexical,
  cloneRule,
  scratchRule,
  UnsafePathError,
  WorkspaceEntries,
  type WorkspaceRule,
} from './workspace-entries';

describe('checkLexical', () => {
  const root = '/ws/sessions';
  const ok = (path: string, rule: WorkspaceRule) =>
    checkLexical(root, path, rule);
  const refused = (path: string, rule: WorkspaceRule) =>
    expect(() => checkLexical(root, path, rule)).toThrow(UnsafePathError);

  it('accepts a clone of the session', () => {
    expect(ok('/ws/sessions/s1/acme/app', cloneRule('s1'))).toEqual([
      's1',
      'acme',
      'app',
    ]);
  });

  it('refuses everything else', () => {
    const rule = cloneRule('s1');
    refused('/ws/sessions', rule); // the root itself
    refused('/ws/sessions/s1', rule); // too shallow
    refused('/ws/sessions/s1/acme', rule);
    refused('/ws/sessions/s1/acme/app/src', rule); // too deep
    refused('/ws/sessions/s2/acme/app', rule); // another session
    refused('/ws/sessions/s1/acme/app/', rule); // trailing slash
    refused('/ws/sessions/s1/acme/../../../etc', rule); // not normalized
    refused('/ws/sessions/s1/./acme/app', rule);
    refused('/ws/sessions//s1/acme/app', rule);
    refused('ws/sessions/s1/acme/app', rule); // relative
    refused('/ws/sessions-evil/s1/acme/app', rule); // a prefix, not inside
    refused('/ws/sessions/s1/acme/app\0x', rule);
    refused('', rule);
    refused('/ws/sessions/s1/acme/app', cloneRule(null)); // no slug: nothing
    refused('/ws/sessions/s1/acme/app', cloneRule(''));
  });

  it('allows any depth the rule names, for orphans', () => {
    const rule: WorkspaceRule = { area: 'sessions', depths: [1, 2, 3] };
    expect(ok('/ws/sessions/x', rule)).toEqual(['x']);
    expect(ok('/ws/sessions/x/y/z', rule)).toHaveLength(3);
    refused('/ws/sessions/x/y/z/w', rule);
  });
});

describe('WorkspaceEntries', () => {
  let base: string;
  let sessionsDir: string;
  let scratchDir: string;
  let outside: string;
  let entries: WorkspaceEntries;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'crm-entries-')));
    sessionsDir = join(base, 'workspace', 'sessions');
    scratchDir = join(base, 'workspace', 'scratch');
    outside = join(base, 'outside');
    for (const dir of [sessionsDir, scratchDir, outside]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(outside, 'precious.txt'), 'keep me');
    entries = new WorkspaceEntries({
      sessionsDir,
      scratchDir,
    } as AppConfig);
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const clone = (slug: string, owner = 'acme', name = 'app') => {
    const path = join(sessionsDir, slug, owner, name);
    mkdirSync(join(path, '.git', 'objects'), { recursive: true });
    writeFileSync(join(path, 'README.md'), 'hello');
    writeFileSync(join(path, '.git', 'objects', 'abc'), 'object');
    return path;
  };
  const outsideIntact = () =>
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep me');

  it('removes a clone with everything in it', async () => {
    const path = clone('s1');
    mkdirSync(join(path, 'deep', 'er'), { recursive: true });
    writeFileSync(join(path, 'deep', 'er', 'x'), 'x');
    expect(await entries.remove(path, cloneRule('s1'))).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(sessionsDir, 's1', 'acme'))).toBe(true);
  });

  it('reports a directory that does not exist', async () => {
    expect(
      await entries.remove(join(sessionsDir, 's1', 'a', 'b'), cloneRule('s1')),
    ).toBe(false);
  });

  it('removes only the clone, not one whose name starts the same', async () => {
    const path = clone('s1', 'acme', 'app');
    const sibling = clone('s1', 'acme', 'app2');
    await entries.remove(path, cloneRule('s1'));
    expect(existsSync(join(sibling, 'README.md'))).toBe(true);
  });

  it('removes symlinks inside a clone without following them', async () => {
    const path = clone('s1');
    symlinkSync(outside, join(path, 'link-to-outside'));
    symlinkSync(join(outside, 'precious.txt'), join(path, 'file-link'));
    linkSync(join(outside, 'precious.txt'), join(path, 'hardlink'));
    await entries.remove(path, cloneRule('s1'));
    expect(existsSync(path)).toBe(false);
    outsideIntact();
  });

  it('refuses a clone directory that is a symlink', async () => {
    mkdirSync(join(sessionsDir, 's1', 'acme'), { recursive: true });
    const path = join(sessionsDir, 's1', 'acme', 'app');
    symlinkSync(outside, path);
    await expect(entries.remove(path, cloneRule('s1'))).rejects.toThrow(
      UnsafePathError,
    );
    outsideIntact();
    expect(existsSync(path)).toBe(true);
  });

  it('refuses a path that goes through a symlinked parent', async () => {
    mkdirSync(join(outside, 'acme', 'app'), { recursive: true });
    writeFileSync(join(outside, 'acme', 'app', 'file'), 'outside');
    symlinkSync(outside, join(sessionsDir, 's1'));
    const path = join(sessionsDir, 's1', 'acme', 'app');
    await expect(entries.remove(path, cloneRule('s1'))).rejects.toThrow(
      /symbolic link/,
    );
    expect(existsSync(join(outside, 'acme', 'app', 'file'))).toBe(true);
  });

  it('refuses paths from the database that point elsewhere', async () => {
    const hostile = [
      outside,
      join(sessionsDir, 's1', '..', '..', '..', 'outside'),
      join(sessionsDir, '..', 'scratch'),
      sessionsDir,
      join(sessionsDir, 's1'),
      `${sessionsDir}-x/s1/acme/app`,
      '/',
      '/etc/passwd',
    ];
    for (const path of hostile) {
      await expect(entries.remove(path, cloneRule('s1'))).rejects.toThrow(
        UnsafePathError,
      );
    }
    outsideIntact();
    expect(existsSync(scratchDir)).toBe(true);
  });

  it('refuses a file where a directory is expected', async () => {
    mkdirSync(join(sessionsDir, 's1', 'acme'), { recursive: true });
    const path = join(sessionsDir, 's1', 'acme', 'app');
    writeFileSync(path, 'a file');
    await expect(entries.remove(path, cloneRule('s1'))).rejects.toThrow(
      /not a directory/,
    );
  });

  it('refuses a directory that holds another session’s directory', async () => {
    const path = clone('s1');
    const rule: WorkspaceRule = { area: 'sessions', depths: [1, 2, 3] };
    await expect(
      entries.remove(join(sessionsDir, 's1'), rule, [path]),
    ).rejects.toThrow(/another session uses/);
    expect(existsSync(join(path, 'README.md'))).toBe(true);
    // The protected directory itself is refused as well.
    await expect(entries.remove(path, rule, [path])).rejects.toThrow(
      UnsafePathError,
    );
  });

  it('removes a scratch directory only under the scratch root', async () => {
    const path = join(scratchDir, 's1');
    mkdirSync(join(path, 'sub'), { recursive: true });
    writeFileSync(join(path, 'sub', 'notes.txt'), 'n');
    await expect(
      entries.remove(join(sessionsDir, 's1'), scratchRule('s1')),
    ).rejects.toThrow(UnsafePathError);
    expect(await entries.remove(path, scratchRule('s1'))).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(scratchDir)).toBe(true);
  });

  it('tells what a directory holds', async () => {
    const path = clone('s1');
    writeFileSync(join(path, 'b.txt'), 'bb');
    const contents = await entries.inspect(path, cloneRule('s1'));
    expect(contents).toMatchObject({
      fileCount: 2,
      files: ['README.md', 'b.txt'],
      git: true,
    });
    expect(contents?.bytes).toBeGreaterThan(0);
    expect(
      await entries.inspect(join(sessionsDir, 's1', 'x', 'y'), cloneRule('s1')),
    ).toBeNull();
  });
});
