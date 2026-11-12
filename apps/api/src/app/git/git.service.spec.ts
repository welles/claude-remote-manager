import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GitService,
  isValidBranchName,
  parseWorktreeList,
} from './git.service';
import {
  commitFile,
  createOrigin,
  git,
  gitSandbox,
} from './testing/git-fixtures';

describe('GitService', () => {
  let sandbox: ReturnType<typeof gitSandbox>;
  let service: GitService;
  let origin: string;
  let clone: string;
  let worktrees: string;
  let initial: string;

  /** Adds a worktree for a session slug from the fetched `main`. */
  const addSession = async (slug: string, base = 'main') => {
    const baseCommit = await service.remoteBranchCommit(clone, base);
    const path = join(worktrees, slug);
    await service.addWorktree({
      repoPath: clone,
      path,
      branch: `claude/${slug}`,
      baseCommit,
      lockReason: `session ${slug}`,
    });
    return path;
  };

  /** Everything that makes up a worktree's state. */
  const snapshot = async (path: string) => ({
    head: await git(path, 'rev-parse', 'HEAD'),
    branch: await git(path, 'symbolic-ref', '--short', 'HEAD'),
    status: await git(
      path,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ),
    staged: await git(path, 'diff', '--cached', '--name-status'),
    readme: await readFile(join(path, 'README.md'), 'utf8'),
  });

  beforeEach(async () => {
    sandbox = gitSandbox();
    service = new GitService();
    origin = join(sandbox.dir, 'origin');
    clone = join(sandbox.dir, 'repos', 'acme', 'tool');
    worktrees = join(sandbox.dir, 'worktrees', 'acme', 'tool');
    initial = await createOrigin(origin);
  });

  afterEach(() => sandbox.cleanup());

  describe('update', () => {
    it('clones a bare repository that only has remote-tracking branches', async () => {
      await git(origin, 'tag', 'v1');
      await git(origin, 'branch', 'feature');

      const result = await service.update(clone, origin);

      expect(result).toEqual({ defaultBranch: 'main', cloned: true });
      expect(await git(clone, 'rev-parse', '--is-bare-repository')).toBe(
        'true',
      );
      expect(await git(clone, 'for-each-ref', '--format=%(refname)')).toBe(
        [
          'refs/remotes/origin/HEAD',
          'refs/remotes/origin/feature',
          'refs/remotes/origin/main',
          'refs/tags/v1',
        ].join('\n'),
      );
      expect(await service.remoteBranches(clone)).toEqual(['feature', 'main']);
      expect(await service.remoteBranchCommit(clone, 'main')).toBe(initial);
      expect(await service.remoteBranchCommit(clone, 'missing')).toBeNull();
      expect(await git(clone, 'config', 'core.logAllRefUpdates')).toBe('true');
    });

    it('fetches afterwards, prunes deleted branches and follows the default branch', async () => {
      await git(origin, 'branch', 'old');
      await service.update(clone, origin);
      const next = await commitFile(origin, 'a.txt', 'a');
      await git(origin, 'branch', '-D', 'old');
      await git(origin, 'branch', '-m', 'main', 'trunk');

      const result = await service.update(clone, origin);

      expect(result).toEqual({ defaultBranch: 'trunk', cloned: false });
      expect(await service.remoteBranches(clone)).toEqual(['trunk']);
      expect(await service.remoteBranchCommit(clone, 'trunk')).toBe(next);
    });

    it('lets concurrent callers share one update', async () => {
      const first = service.update(clone, origin);
      const second = service.update(clone, origin);

      expect(second).toBe(first);
      expect(service.isUpdating(clone)).toBe(true);
      await first;
      expect(service.isUpdating(clone)).toBe(false);
    });

    it('leaves nothing behind when cloning fails and cleans up interrupted clones', async () => {
      await mkdir(join(sandbox.dir, 'repos', 'acme', '.tool.clone-dead'), {
        recursive: true,
      });

      await expect(
        service.update(clone, join(sandbox.dir, 'missing')),
      ).rejects.toThrow('git fetch failed');

      expect(existsSync(clone)).toBe(false);
      expect(
        existsSync(join(sandbox.dir, 'repos', 'acme', '.tool.clone-dead')),
      ).toBe(false);
    });

    it('refuses to fetch into a clone of another remote or a foreign directory', async () => {
      await service.update(clone, origin);
      await expect(service.update(clone, '/elsewhere/tool')).rejects.toThrow(
        'is a clone of',
      );

      const plain = join(sandbox.dir, 'repos', 'acme', 'plain');
      await mkdir(plain, { recursive: true });
      await expect(service.update(plain, origin)).rejects.toThrow(
        'is not a bare repository',
      );
    });

    it('handles an empty remote', async () => {
      const empty = join(sandbox.dir, 'empty');
      await git(sandbox.dir, 'init', '--quiet', '--bare', '--', empty);

      expect(await service.update(clone, empty)).toEqual({
        defaultBranch: null,
        cloned: true,
      });
      expect(await service.isEmpty(clone)).toBe(true);
    });
  });

  describe('worktrees', () => {
    beforeEach(() => service.update(clone, origin));

    it('creates a locked worktree on a new branch at the base commit', async () => {
      const path = await addSession('fix-login-abc123');

      expect(await snapshot(path)).toMatchObject({
        head: initial,
        branch: 'claude/fix-login-abc123',
        status: '',
      });
      // No upstream: the session branch never pulls or pushes main.
      await expect(
        git(path, 'rev-parse', '--abbrev-ref', '@{upstream}'),
      ).rejects.toThrow();
      expect(await service.listWorktrees(clone)).toEqual([
        {
          path,
          head: initial,
          branch: 'claude/fix-login-abc123',
          locked: true,
          prunable: false,
        },
      ]);
    });

    it('creates worktrees from another base branch', async () => {
      await git(origin, 'checkout', '--quiet', '-b', 'release');
      const release = await commitFile(origin, 'r.txt', 'r');
      await service.update(clone, origin);

      const path = await addSession('s-1', 'release');

      expect(await git(path, 'rev-parse', 'HEAD')).toBe(release);
    });

    it('creates an orphan worktree for an empty repository', async () => {
      const empty = join(sandbox.dir, 'empty');
      const emptyClone = join(sandbox.dir, 'repos', 'acme', 'empty');
      await git(sandbox.dir, 'init', '--quiet', '--bare', '--', empty);
      await service.update(emptyClone, empty);
      const path = join(sandbox.dir, 'worktrees', 'acme', 'empty', 's');

      await service.addWorktree({
        repoPath: emptyClone,
        path,
        branch: 'claude/s',
        baseCommit: null,
        lockReason: 'session s',
      });

      expect(await git(path, 'symbolic-ref', '--short', 'HEAD')).toBe(
        'claude/s',
      );
      await commitFile(path, 'first.txt', '1');
      expect(await service.branchExists(emptyClone, 'claude/s')).toBe(true);
    });

    it('does not run repository hooks', async () => {
      const marker = join(sandbox.dir, 'hook-ran');
      const hook = join(clone, 'hooks', 'post-checkout');
      await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
      await chmod(hook, 0o755);

      await addSession('hooked');

      expect(existsSync(marker)).toBe(false);
    });

    it('refuses an existing branch and leaves no branch behind on failure', async () => {
      await addSession('taken');
      await expect(addSession('taken')).rejects.toThrow('already exists');

      const occupied = join(worktrees, 'occupied');
      await mkdir(occupied, { recursive: true });
      await writeFile(join(occupied, 'file'), 'x');
      await expect(addSession('occupied')).rejects.toThrow(
        'git worktree failed',
      );
      expect(await service.branchExists(clone, 'claude/occupied')).toBe(false);
      expect(await readFile(join(occupied, 'file'), 'utf8')).toBe('x');
    });

    it('removes a worktree, refusing dirty ones unless forced', async () => {
      const path = await addSession('remove-me');
      await writeFile(join(path, 'scratch.txt'), 'untracked');

      await expect(service.removeWorktree(clone, path)).rejects.toThrow(
        'git worktree failed',
      );
      // Still there and locked again.
      expect((await service.listWorktrees(clone))[0]).toMatchObject({
        path,
        locked: true,
      });

      await service.removeWorktree(clone, path, { force: true });
      expect(existsSync(path)).toBe(false);
      expect(await service.listWorktrees(clone)).toEqual([]);
      // The branch is kept until it is deleted explicitly.
      expect(await service.branchExists(clone, 'claude/remove-me')).toBe(true);
      await service.deleteBranch(clone, 'claude/remove-me');
      expect(await service.branchExists(clone, 'claude/remove-me')).toBe(false);
      // Removing again is a no-op.
      await service.removeWorktree(clone, path);
    });

    it('unregisters a worktree whose directory is gone without pruning locked ones', async () => {
      const gone = await addSession('gone');
      const away = await addSession('away');
      await rename(gone, `${gone}-deleted`);
      await rename(away, `${away}-unmounted`);
      // What `git gc` does; locked worktrees survive it.
      await git(clone, 'worktree', 'prune');
      expect(
        (await service.listWorktrees(clone)).map((entry) => entry.path).sort(),
      ).toEqual([away, gone].sort());

      await service.removeWorktree(clone, gone);

      const remaining = await service.listWorktrees(clone);
      expect(remaining).toEqual([
        // Git does not even report locked worktrees as prunable.
        expect.objectContaining({ path: away, locked: true, prunable: false }),
      ]);
    });

    it('refuses to remove a directory that is not a worktree', async () => {
      const foreign = join(worktrees, 'foreign');
      await mkdir(foreign, { recursive: true });
      await expect(service.removeWorktree(clone, foreign)).rejects.toThrow(
        'is not a worktree',
      );
      expect(existsSync(foreign)).toBe(true);
    });

    it('refuses to delete a branch that a worktree has checked out', async () => {
      await addSession('busy');
      await expect(service.deleteBranch(clone, 'claude/busy')).rejects.toThrow(
        'git branch failed',
      );
      await expect(service.deleteBranch(clone, '--force')).rejects.toThrow(
        'not a valid branch name',
      );
    });
  });

  describe('isolation of sessions in the same repository', () => {
    beforeEach(() => service.update(clone, origin));

    it('creates many worktrees concurrently, with fetches in between', async () => {
      const slugs = Array.from(
        { length: 8 },
        (_, index) => `parallel-${index}`,
      );
      const remoteCommit = commitFile(origin, 'new.txt', 'new');

      const results = await Promise.allSettled([
        ...slugs.map((slug) => addSession(slug)),
        service.update(clone, origin),
        remoteCommit.then(() => service.update(clone, origin)),
      ]);

      expect(results.filter((result) => result.status === 'rejected')).toEqual(
        [],
      );
      const listed = await service.listWorktrees(clone);
      expect(listed.map((entry) => entry.branch).sort()).toEqual(
        slugs.map((slug) => `claude/${slug}`).sort(),
      );
      expect(new Set(listed.map((entry) => entry.path)).size).toBe(
        slugs.length,
      );
      expect(await service.remoteBranchCommit(clone, 'main')).toBe(
        await remoteCommit,
      );
      for (const entry of listed) {
        expect(await git(entry.path, 'status', '--porcelain')).toBe('');
      }
    });

    it('keeps files, index, HEAD and branch of one session untouched by the others', async () => {
      const a = await addSession('session-a');
      const b = await addSession('session-b');
      await writeFile(join(b, 'README.md'), '# Changed by B, not committed\n');
      await writeFile(join(b, 'staged.txt'), 'staged in B');
      await git(b, 'add', 'staged.txt');
      const before = await snapshot(b);

      // Session A works: commits, stages, creates and switches branches.
      await commitFile(a, 'README.md', '# A\n', 'A changes README');
      await writeFile(join(a, 'only-a.txt'), 'a');
      await git(a, 'add', 'only-a.txt');
      await git(a, 'checkout', '--quiet', '-b', 'claude/session-a-2');
      // A cannot take over B's branch.
      await expect(
        git(a, 'checkout', '--quiet', 'claude/session-b'),
      ).rejects.toThrow();
      // The app fetches new remote commits and creates a third session.
      await commitFile(origin, 'README.md', '# Remote\n');
      await service.update(clone, origin);
      const c = await addSession('session-c');
      // And removes A with its branch.
      await service.removeWorktree(clone, a, { force: true });
      await service.deleteBranch(clone, 'claude/session-a-2');

      expect(await snapshot(b)).toEqual(before);
      expect(await git(b, 'rev-parse', 'HEAD')).toBe(initial);
      expect(await readFile(join(c, 'README.md'), 'utf8')).toBe('# Remote\n');
      expect(await git(clone, 'rev-parse', 'refs/heads/claude/session-b')).toBe(
        initial,
      );
    });

    it('keeps session branches when fetching, also if the remote has a branch of that name', async () => {
      const a = await addSession('same-name');
      const local = await commitFile(a, 'local.txt', 'local');
      await git(origin, 'branch', 'claude/same-name');
      await commitFile(origin, 'remote.txt', 'remote');

      await service.update(clone, origin);

      expect(await git(clone, 'rev-parse', 'refs/heads/claude/same-name')).toBe(
        local,
      );
      expect(await git(a, 'rev-parse', 'HEAD')).toBe(local);
      expect(await service.remoteBranches(clone)).toContain('claude/same-name');
    });

    it('removes one session worktree while another keeps working', async () => {
      const a = await addSession('stay');
      const b = await addSession('leave');
      await writeFile(join(a, 'work.txt'), 'in progress');

      await Promise.all([
        service.removeWorktree(clone, b, { force: true }),
        commitFile(a, 'work.txt', 'in progress'),
        service.update(clone, origin),
      ]);

      expect(existsSync(b)).toBe(false);
      expect(await git(a, 'status', '--porcelain')).toBe('');
      expect(await git(a, 'log', '--format=%s', '-1')).toBe('Change work.txt');
      expect((await service.listWorktrees(clone)).map((w) => w.path)).toEqual([
        a,
      ]);
    });
  });

  describe('initProject', () => {
    it('creates an empty repository on main and refuses existing directories', async () => {
      const path = join(sandbox.dir, 'projects', 'new-app');

      await service.initProject(path);

      expect(await git(path, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
      expect(await git(path, 'rev-parse', '--show-toplevel')).toBe(path);
      await expect(service.initProject(path)).rejects.toThrow('EEXIST');
    });
  });
});

describe('isValidBranchName', () => {
  it.each(['main', 'release/1.2', 'feature/x_y-z', 'v1.0+build'])(
    'accepts %s',
    (name) => expect(isValidBranchName(name)).toBe(true),
  );

  it.each([
    '',
    '-x',
    '--upload-pack=evil',
    'a..b',
    'a//b',
    'a/.b',
    '.a',
    'a.',
    'a/',
    'a.lock',
    'a@{1}',
    'a b',
    'a~1',
    'a^',
    'a:b',
    'a\\b',
    'x'.repeat(201),
  ])('refuses %j', (name) => expect(isValidBranchName(name)).toBe(false));
});

describe('parseWorktreeList', () => {
  it('reads the porcelain format without the bare entry', () => {
    const output = [
      'worktree /repos/a',
      'bare',
      '',
      'worktree /wt/a/one',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/claude/one',
      'locked session one',
      '',
      'worktree /wt/a/two',
      'HEAD 2222222222222222222222222222222222222222',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');

    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/wt/a/one',
        head: '1111111111111111111111111111111111111111',
        branch: 'claude/one',
        locked: true,
        prunable: false,
      },
      {
        path: '/wt/a/two',
        head: '2222222222222222222222222222222222222222',
        branch: null,
        locked: false,
        prunable: true,
      },
    ]);
  });
});
