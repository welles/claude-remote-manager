import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, relative } from 'node:path';
import { GitService, isValidBranchName, parseRemoteHead } from './git.service';
import {
  commitFile,
  createOrigin,
  git,
  gitSandbox,
} from './testing/git-fixtures';

/** Every file, link and directory below `root` with a hash of its content. */
async function treeSnapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = relative(root, path);
      if (entry.isDirectory()) {
        result[key] = 'dir';
        await walk(path);
      } else if (entry.isSymbolicLink()) {
        result[key] = `link:${await readlink(path)}`;
      } else {
        result[key] = createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
      }
    }
  };
  await walk(root);
  return result;
}

/** Object files (loose objects and packs) below a git directory. */
async function objectFiles(gitDir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (!entry.name.startsWith('tmp')) {
        files.push(relative(gitDir, path));
      }
    }
  };
  await walk(join(gitDir, 'objects'));
  return files.filter((file) => !file.startsWith('objects/info'));
}

describe('GitService', () => {
  let sandbox: ReturnType<typeof gitSandbox>;
  let service: GitService;
  let origin: string;
  let mirror: string;
  let sessions: string;
  let initial: string;

  /** Creates a session clone for a slug from a branch of the mirror. */
  const addSession = async (slug: string, base = 'main') => {
    const path = join(sessions, slug, 'acme', 'tool');
    await service.createSessionClone({
      mirrorPath: mirror,
      path,
      remoteUrl: origin,
      branch: `claude/${slug}`,
      baseCommit: await service.branchCommit(mirror, base),
    });
    return path;
  };

  beforeEach(async () => {
    sandbox = gitSandbox();
    service = new GitService();
    origin = join(sandbox.dir, 'remote', 'tool');
    mirror = join(sandbox.dir, 'workspace', 'repos', 'acme', 'tool');
    sessions = join(sandbox.dir, 'workspace', 'sessions');
    initial = await createOrigin(origin);
  });

  afterEach(() => sandbox.cleanup());

  describe('mirrors', () => {
    it('clones the remote branches as the mirror’s own branches', async () => {
      await git(origin, 'tag', 'v1');
      await git(origin, 'branch', 'feature');

      const result = await service.updateMirror(mirror, origin);

      expect(result).toEqual({ defaultBranch: 'main', created: true });
      expect(await git(mirror, 'rev-parse', '--is-bare-repository')).toBe(
        'true',
      );
      expect(await git(mirror, 'for-each-ref', '--format=%(refname)')).toBe(
        ['refs/heads/feature', 'refs/heads/main', 'refs/tags/v1'].join('\n'),
      );
      expect(await git(mirror, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
      expect(await service.branches(mirror)).toEqual(['feature', 'main']);
      expect(await service.branchCommit(mirror, 'main')).toBe(initial);
      expect(await service.branchCommit(mirror, 'missing')).toBeNull();
      expect(await git(mirror, 'config', 'receive.denyDeletes')).toBe('true');
    });

    it('fetches afterwards, prunes deleted branches and follows the default branch', async () => {
      await git(origin, 'branch', 'old');
      await service.updateMirror(mirror, origin);
      const next = await commitFile(origin, 'a.txt', 'a');
      await git(origin, 'branch', '-D', 'old');
      await git(origin, 'branch', '-m', 'main', 'trunk');

      const result = await service.updateMirror(mirror, origin);

      expect(result).toEqual({ defaultBranch: 'trunk', created: false });
      expect(await service.branches(mirror)).toEqual(['trunk']);
      expect(await service.branchCommit(mirror, 'trunk')).toBe(next);
    });

    it('lets concurrent callers share one update', async () => {
      const first = service.updateMirror(mirror, origin);
      const second = service.updateMirror(mirror, origin);

      expect(second).toBe(first);
      expect(service.isUpdating(mirror)).toBe(true);
      await first;
      expect(service.isUpdating(mirror)).toBe(false);
    });

    it('leaves nothing behind when cloning fails and cleans up interrupted clones', async () => {
      const leftover = join(mirror, '..', '.tool.clone-dead');
      await mkdir(leftover, { recursive: true });

      await expect(
        service.updateMirror(mirror, join(sandbox.dir, 'missing')),
      ).rejects.toThrow('git fetch failed');

      expect(existsSync(mirror)).toBe(false);
      expect(existsSync(leftover)).toBe(false);
    });

    it('refuses to fetch into a mirror of another remote or a foreign directory', async () => {
      await service.updateMirror(mirror, origin);
      await expect(
        service.updateMirror(mirror, '/elsewhere/tool'),
      ).rejects.toThrow('is a mirror of');

      const plain = join(mirror, '..', 'plain');
      await mkdir(plain, { recursive: true });
      await expect(service.updateMirror(plain, origin)).rejects.toThrow(
        'is not a bare repository',
      );
    });

    it('handles an empty remote', async () => {
      const empty = join(sandbox.dir, 'empty');
      await git(sandbox.dir, 'init', '--quiet', '--bare', '--', empty);

      expect(await service.updateMirror(mirror, empty)).toEqual({
        defaultBranch: null,
        created: true,
      });
      expect(await service.isEmpty(mirror)).toBe(true);
    });

    it('creates the mirror of a local project without remote', async () => {
      const project = join(sandbox.dir, 'workspace', 'repos', 'local', 'app');

      expect(await service.updateMirror(project, null)).toEqual({
        defaultBranch: 'main',
        created: true,
      });
      expect(await service.updateMirror(project, null)).toEqual({
        defaultBranch: 'main',
        created: false,
      });
      expect(await service.isEmpty(project)).toBe(true);
      await expect(git(project, 'remote')).resolves.toBe('');
    });
  });

  describe('session clones', () => {
    beforeEach(() => service.updateMirror(mirror, origin));

    it('creates an independent clone with hardlinked objects on the session branch', async () => {
      await git(origin, 'tag', 'v1');
      await service.updateMirror(mirror, origin);

      const path = await addSession('fix-login-abc123');

      expect(await git(path, 'symbolic-ref', '--short', 'HEAD')).toBe(
        'claude/fix-login-abc123',
      );
      expect(await git(path, 'rev-parse', 'HEAD')).toBe(initial);
      expect(await git(path, 'status', '--porcelain')).toBe('');
      // origin is the real remote, with the mirror's state as origin/*.
      expect(await git(path, 'remote', 'get-url', 'origin')).toBe(origin);
      expect(await git(path, 'rev-parse', 'origin/main')).toBe(initial);
      expect(await git(path, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe(
        'refs/remotes/origin/main',
      );
      expect(await git(path, 'tag')).toBe('v1');
      expect(await git(path, 'branch', '--format=%(refname:short)')).toBe(
        'claude/fix-login-abc123',
      );
      await expect(
        git(path, 'rev-parse', '--abbrev-ref', '@{upstream}'),
      ).rejects.toThrow();
      // Own objects, hardlinked, no alternates.
      expect(existsSync(join(path, '.git/objects/info/alternates'))).toBe(
        false,
      );
      const files = await objectFiles(mirror);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const [inMirror, inClone] = await Promise.all([
          stat(join(mirror, file)),
          stat(join(path, '.git', file)),
        ]);
        expect(inClone.ino).toBe(inMirror.ino);
        expect(inMirror.nlink).toBeGreaterThanOrEqual(2);
      }
      // The mirror's settings stay in the mirror.
      await expect(
        git(path, 'config', '--get', 'receive.denyDeletes'),
      ).rejects.toThrow();
    });

    it('creates sessions from another base branch', async () => {
      await git(origin, 'checkout', '--quiet', '-b', 'release');
      const release = await commitFile(origin, 'r.txt', 'r');
      await service.updateMirror(mirror, origin);

      const path = await addSession('s-1', 'release');

      expect(await git(path, 'rev-parse', 'HEAD')).toBe(release);
    });

    it('starts an unborn session branch in an empty repository', async () => {
      const empty = join(sandbox.dir, 'empty');
      await git(sandbox.dir, 'init', '--quiet', '--bare', '--', empty);
      const emptyMirror = join(
        sandbox.dir,
        'workspace',
        'repos',
        'acme',
        'empty',
      );
      await service.updateMirror(emptyMirror, empty);
      const path = join(sessions, 's', 'acme', 'empty');

      await service.createSessionClone({
        mirrorPath: emptyMirror,
        path,
        remoteUrl: empty,
        branch: 'claude/s',
        baseCommit: null,
      });

      expect(await service.currentBranch(path)).toBe('claude/s');
      await commitFile(path, 'first.txt', '1');
      expect(await git(path, 'log', '--format=%s')).toBe('Change first.txt');
    });

    it('refuses existing directories and removes the clone when it fails', async () => {
      const taken = await addSession('taken');
      await expect(addSession('taken')).rejects.toThrow('already exists');
      expect(await service.currentBranch(taken)).toBe('claude/taken');

      const path = join(sessions, 'broken', 'acme', 'tool');
      await expect(
        service.createSessionClone({
          mirrorPath: mirror,
          path,
          remoteUrl: origin,
          branch: 'claude/broken',
          baseCommit: '0'.repeat(40),
        }),
      ).rejects.toThrow('git checkout failed');
      expect(existsSync(path)).toBe(false);
    });

    it('does not run repository hooks', async () => {
      const marker = join(sandbox.dir, 'hook-ran');
      const hook = join(mirror, 'hooks', 'post-checkout');
      await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
      await chmod(hook, 0o755);

      await addSession('hooked');

      expect(existsSync(marker)).toBe(false);
    });

    it('removes a session clone by deleting it', async () => {
      const path = await addSession('remove-me');
      await service.removeSessionClone(path);
      expect(existsSync(path)).toBe(false);
      await service.removeSessionClone(path);
    });
  });

  describe('isolation of sessions in the same repository', () => {
    beforeEach(() => service.updateMirror(mirror, origin));

    it('creates many session clones concurrently while the mirror fetches', async () => {
      const slugs = Array.from(
        { length: 8 },
        (_, index) => `parallel-${index}`,
      );
      const remoteCommit = commitFile(origin, 'new.txt', 'new');

      const results = await Promise.allSettled([
        ...slugs.map((slug) => addSession(slug)),
        service.updateMirror(mirror, origin),
        remoteCommit.then(() => service.updateMirror(mirror, origin)),
      ]);

      expect(results.filter((result) => result.status === 'rejected')).toEqual(
        [],
      );
      for (const slug of slugs) {
        const path = join(sessions, slug, 'acme', 'tool');
        expect(await service.currentBranch(path)).toBe(`claude/${slug}`);
        expect(await git(path, 'status', '--porcelain')).toBe('');
        await git(path, 'fsck', '--no-progress');
      }
      expect(await service.branchCommit(mirror, 'main')).toBe(
        await remoteCommit,
      );
    });

    it('keeps the mirror and other sessions byte-for-byte unchanged by shared-state commands in one session', async () => {
      const a = await addSession('session-a');
      const b = await addSession('session-b');
      await writeFile(join(b, 'README.md'), '# Changed by B, not committed\n');
      await writeFile(join(b, 'staged.txt'), 'staged in B');
      await git(b, 'add', 'staged.txt');
      await git(b, 'stash', 'list');
      const beforeB = await treeSnapshot(b);
      const beforeMirror = await treeSnapshot(mirror);

      // Session A does everything that linked worktrees would share.
      await writeFile(join(a, 'README.md'), '# work in progress\n');
      await git(a, 'stash', 'push', '--quiet');
      await git(a, 'tag', 'v1');
      await git(a, 'tag', '-f', 'v1', 'HEAD');
      await git(a, 'tag', '-d', 'v1');
      await git(a, 'config', 'core.hooksPath', '.husky');
      await git(a, 'config', 'user.name', 'Somebody else');
      await writeFile(
        join(a, '.git', 'hooks', 'pre-commit'),
        '#!/bin/sh\nexit 1\n',
      );
      await git(a, 'branch', 'claude/session-b');
      await git(a, 'branch', 'main', 'origin/main');
      await git(a, 'branch', '-D', 'claude/session-b');
      await git(a, 'checkout', '--quiet', 'main');
      await commitFile(a, 'a.txt', 'a', 'Commit on A’s main');
      await git(a, 'worktree', 'add', '--quiet', join(sandbox.dir, 'a-extra'));
      await git(a, 'worktree', 'remove', join(sandbox.dir, 'a-extra'));
      await git(a, 'reflog', 'expire', '--expire=now', '--all');
      await git(a, 'gc', '--quiet', '--prune=now');
      await git(a, 'remote', 'set-url', 'origin', '/somewhere/else');

      expect(await treeSnapshot(b)).toEqual(beforeB);
      expect(await treeSnapshot(mirror)).toEqual(beforeMirror);
      expect(await git(b, 'stash', 'list')).toBe('');
      expect(await git(b, 'tag')).toBe('');
      expect(await git(b, 'rev-parse', 'HEAD')).toBe(initial);
      expect(await service.currentBranch(b)).toBe('claude/session-b');
      await git(b, 'fsck', '--no-progress');
    });

    it('lets one session work while another session’s clone is deleted', async () => {
      const a = await addSession('leave');
      const b = await addSession('stay');
      await writeFile(join(b, 'work.txt'), 'in progress');

      await Promise.all([
        service.removeSessionClone(a),
        commitFile(b, 'work.txt', 'in progress'),
        service.updateMirror(mirror, origin),
      ]);

      expect(existsSync(a)).toBe(false);
      expect(await git(b, 'log', '--format=%s', '-1')).toBe('Change work.txt');
      await git(b, 'fsck', '--no-progress');
    });

    it('keeps existing session clones intact when the mirror is garbage-collected', async () => {
      const path = await addSession('before-gc');
      await commitFile(origin, 'more.txt', 'more');
      await service.updateMirror(mirror, origin);
      await git(mirror, 'repack', '-a', '-d', '--quiet');
      await git(mirror, 'gc', '--quiet', '--prune=now');

      await git(path, 'fsck', '--full', '--no-progress');
      expect(await git(path, 'log', '--format=%s')).toBe('Initial commit');
      const after = await addSession('after-gc');
      expect(await git(after, 'log', '--format=%s', '-1')).toBe(
        'Change more.txt',
      );
    });
  });

  describe('local projects', () => {
    let project: string;
    const addProjectSession = async (slug: string) => {
      const path = join(sessions, slug, 'local', 'app');
      await service.createSessionClone({
        mirrorPath: project,
        path,
        remoteUrl: null,
        branch: `claude/${slug}`,
        baseCommit: await service.branchCommit(project, 'main'),
      });
      return path;
    };

    beforeEach(async () => {
      project = join(sandbox.dir, 'workspace', 'repos', 'local', 'app');
      await service.updateMirror(project, null);
    });

    it('shows a session’s work to later sessions only after it was integrated', async () => {
      const first = await addProjectSession('first');
      expect(await git(first, 'remote', 'get-url', 'origin')).toBe(project);
      const work = await commitFile(first, 'app.txt', 'v1', 'First version');
      const second = await addProjectSession('second');
      expect(existsSync(join(second, 'app.txt'))).toBe(false);

      expect(
        await service.fastForwardMirror({
          mirrorPath: project,
          clonePath: first,
          sourceBranch: 'claude/first',
          targetBranch: 'main',
        }),
      ).toBe(work);

      const third = await addProjectSession('third');
      expect(await readFile(join(third, 'app.txt'), 'utf8')).toBe('v1');
      expect(existsSync(join(second, 'app.txt'))).toBe(false);
    });

    it('refuses to integrate what is not a fast-forward, and pushes that rewrite or delete', async () => {
      const first = await addProjectSession('first');
      await commitFile(first, 'app.txt', 'v1');
      await service.fastForwardMirror({
        mirrorPath: project,
        clonePath: first,
        sourceBranch: 'claude/first',
        targetBranch: 'main',
      });
      const second = await addProjectSession('second');
      await commitFile(first, 'app.txt', 'v2');
      await service.fastForwardMirror({
        mirrorPath: project,
        clonePath: first,
        sourceBranch: 'claude/first',
        targetBranch: 'main',
      });
      await commitFile(second, 'other.txt', 'diverged');

      await expect(
        service.fastForwardMirror({
          mirrorPath: project,
          clonePath: second,
          sourceBranch: 'claude/second',
          targetBranch: 'main',
        }),
      ).rejects.toThrow('git fetch failed');
      await expect(
        git(second, 'push', '--quiet', '--force', 'origin', 'HEAD:main'),
      ).rejects.toThrow();
      await expect(
        git(first, 'push', '--quiet', 'origin', ':main'),
      ).rejects.toThrow();
    });

    it('refuses to integrate into a repository with a remote', async () => {
      await service.updateMirror(mirror, origin);
      const path = await addSession('remote');
      await expect(
        service.fastForwardMirror({
          mirrorPath: mirror,
          clonePath: path,
          sourceBranch: 'claude/remote',
          targetBranch: 'main',
        }),
      ).rejects.toThrow('pushing to it');
    });
  });

  it('keeps clones usable after their files are removed from the mirror', async () => {
    await service.updateMirror(mirror, origin);
    const path = await addSession('survivor');
    await rm(mirror, { recursive: true, force: true });
    await git(path, 'fsck', '--full', '--no-progress');
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

describe('parseRemoteHead', () => {
  it('reads the default branch from ls-remote --symref', () => {
    expect(parseRemoteHead('ref: refs/heads/trunk\tHEAD\nabc123\tHEAD\n')).toBe(
      'trunk',
    );
    expect(parseRemoteHead('')).toBeNull();
  });
});
