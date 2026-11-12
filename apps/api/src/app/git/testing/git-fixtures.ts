import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../git-runner';

/** git in a working directory, trimmed stdout. */
export const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await runGit(args, { cwd })).trim();

/**
 * A temporary directory with its own git configuration (identity, default
 * branch `main`), independent of the user's. Call `cleanup` after the test.
 */
export function gitSandbox(prefix = 'crm-git-'): {
  dir: string;
  cleanup(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const saved = {
    global: process.env['GIT_CONFIG_GLOBAL'],
    system: process.env['GIT_CONFIG_NOSYSTEM'],
  };
  const config = join(dir, 'gitconfig');
  writeFileSync(
    config,
    '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n',
  );
  process.env['GIT_CONFIG_GLOBAL'] = config;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  return {
    dir,
    cleanup: () => {
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      };
      restore('GIT_CONFIG_GLOBAL', saved.global);
      restore('GIT_CONFIG_NOSYSTEM', saved.system);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Writes a file and commits it; returns the commit. */
export async function commitFile(
  repo: string,
  file: string,
  content: string,
  message = `Change ${file}`,
): Promise<string> {
  await writeFile(join(repo, file), content);
  await git(repo, 'add', '--', file);
  await git(repo, 'commit', '--quiet', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** A normal repository with one commit on `main`, acting as the remote. */
export async function createOrigin(path: string): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await git(
    join(path, '..'),
    'init',
    '--quiet',
    '--initial-branch=main',
    '--',
    path,
  );
  return commitFile(path, 'README.md', '# Test\n', 'Initial commit');
}
