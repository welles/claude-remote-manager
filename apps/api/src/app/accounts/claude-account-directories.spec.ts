import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SINGLE_USER } from '../common/process-isolation';
import { ClaudeAccountDirectories } from './claude-account-directories';

const ID = '0b6f3c2e-3c1a-4b8e-9a51-2f1d1b0c9e77';

describe('ClaudeAccountDirectories', () => {
  let dir: string;
  let main: string;
  let directories: ClaudeAccountDirectories;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crm-account-dirs-'));
    main = join(dir, 'claude');
    mkdirSync(main);
    directories = new ClaudeAccountDirectories(
      main,
      SINGLE_USER,
      join(main, '.claude.json'),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const account = () => join(main, 'crm-accounts', ID);
  const state = () =>
    JSON.parse(readFileSync(join(account(), '.claude.json'), 'utf8'));

  it('links the shared entries, keeps login and state its own, and copes with parallel calls', async () => {
    writeFileSync(join(main, '.credentials.json'), '{}');
    writeFileSync(join(main, '.credentials.json.lock'), '');
    writeFileSync(join(main, 'CLAUDE.md'), '# rules');
    writeFileSync(
      join(main, '.claude.json'),
      JSON.stringify({ mcpServers: { docs: { command: 'docs' } } }),
    );

    await Promise.all([
      directories.prepare(ID),
      directories.prepare(ID),
      directories.prepare(ID),
    ]);

    expect(readlinkSync(join(account(), 'CLAUDE.md'))).toBe(
      join('..', '..', 'CLAUDE.md'),
    );
    // Created in the main directory first, so that it is shared.
    expect(readFileSync(join(main, 'settings.json'), 'utf8')).toBe('{}\n');
    expect(lstatSync(join(account(), 'settings.json')).isSymbolicLink()).toBe(
      true,
    );
    expect(lstatSync(join(main, 'projects')).isDirectory()).toBe(true);
    expect(existsSync(join(account(), '.credentials.json'))).toBe(false);
    expect(existsSync(join(account(), '.credentials.json.lock'))).toBe(false);
    expect(state()).toEqual({ mcpServers: { docs: { command: 'docs' } } });

    // Claude Code's own state stays; only the servers follow the main one,
    // and not while Claude Code holds the lock.
    writeFileSync(
      join(account(), '.claude.json'),
      JSON.stringify({ userID: 'u', mcpServers: {} }),
    );
    mkdirSync(join(account(), '.claude.json.lock'));
    await directories.prepare(ID);
    expect(state()).toEqual({ userID: 'u', mcpServers: {} });
    rmSync(join(account(), '.claude.json.lock'), { recursive: true });
    await directories.prepare(ID);
    expect(state()).toEqual({
      userID: 'u',
      mcpServers: { docs: { command: 'docs' } },
    });

    await directories.remove(ID);
    expect(existsSync(account())).toBe(false);
    expect(readFileSync(join(main, 'CLAUDE.md'), 'utf8')).toBe('# rules');
  });

  it('refuses an accounts directory that is a symlink, and a state file that is one', async () => {
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(main, 'crm-accounts'));
    await expect(directories.prepare(ID)).rejects.toThrow(/not a directory/);
    await expect(directories.remove(ID)).rejects.toThrow(/not a directory/);

    rmSync(join(main, 'crm-accounts'));
    await directories.prepare(ID);
    const target = join(dir, 'target.json');
    writeFileSync(target, '{"secret":true}');
    rmSync(join(account(), '.claude.json'), { force: true });
    symlinkSync(target, join(account(), '.claude.json'));
    writeFileSync(
      join(main, '.claude.json'),
      JSON.stringify({ mcpServers: { a: {} } }),
    );
    await directories.prepare(ID);
    expect(readFileSync(target, 'utf8')).toBe('{"secret":true}');
  });

  it('accepts shared directories that are symlinks to directories', async () => {
    const dotfiles = join(dir, 'dotfiles-skills');
    mkdirSync(dotfiles);
    writeFileSync(join(dotfiles, 'SKILL.md'), 'skill');
    symlinkSync(dotfiles, join(main, 'skills'));
    await directories.prepare(ID);
    expect(readFileSync(join(account(), 'skills', 'SKILL.md'), 'utf8')).toBe(
      'skill',
    );
  });

  it('rejects names that are no account IDs', async () => {
    await expect(directories.prepare('../x')).rejects.toThrow(/usage/);
  });
});
