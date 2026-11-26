import { existsSync, readdirSync } from 'node:fs';
import {
  mkdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionDiffFile } from '@claude-remote-manager/shared-types';
import { openDatabase, type AppDatabase } from '../db/database';
import {
  commitFile,
  createOrigin,
  git,
  gitSandbox,
} from '../git/testing/git-fixtures';
import { RepositoryRepository } from '../repositories/repository.repository';
import { SessionRepository } from '../sessions/session.repository';
import {
  DiffOutputParser,
  parseRawNumstat,
  PatchParser,
  type FilePatch,
} from './git-diff-parser';
import {
  diffFile,
  SESSION_DIFF_LIMITS,
  SessionDiffService,
} from './session-diff.service';

describe('SessionDiffService', () => {
  let sandbox: ReturnType<typeof gitSandbox>;
  let db: AppDatabase;
  let sessions: SessionRepository;
  let service: SessionDiffService;
  let app: string;
  let lib: string;
  let baseApp: string;
  let baseLib: string;

  /** A repository with some files, as a session clone. */
  const clone = async (name: string) => {
    const path = join(sandbox.dir, 'sessions', 's1', 'acme', name);
    await createOrigin(path);
    await mkdir(join(path, 'src'), { recursive: true });
    await writeFile(
      join(path, 'src', 'main.ts'),
      Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
    );
    await writeFile(join(path, 'old-name.txt'), 'stays the same\n'.repeat(5));
    await writeFile(join(path, 'gone.txt'), 'bye\n');
    await writeFile(join(path, '.gitignore'), 'dist/\n');
    await git(path, 'add', '.');
    await git(path, 'commit', '--quiet', '-m', 'Base');
    return { path, base: await git(path, 'rev-parse', 'HEAD') };
  };

  const files = async () => {
    const diff = await service.sessionDiff('s1');
    return diff.repositories.map((repository) => ({
      repository: repository.repository,
      state: repository.state,
      files: repository.files.map((file) => `${file.status} ${file.path}`),
    }));
  };

  beforeEach(async () => {
    sandbox = gitSandbox('crm-session-diff-');
    db = openDatabase(':memory:');
    sessions = new SessionRepository(db);
    service = new SessionDiffService(sessions);
    ({ path: app, base: baseApp } = await clone('app'));
    ({ path: lib, base: baseLib } = await clone('lib'));
    const repositories = new RepositoryRepository(db);
    for (const [id, name] of [
      ['r-app', 'app'],
      ['r-lib', 'lib'],
    ]) {
      repositories.create({
        id,
        owner: 'acme',
        name,
        cloneUrl: null,
        localPath: join(sandbox.dir, 'repos', name),
        setupScript: null,
      });
    }
    sessions.create({
      id: 's1',
      title: null,
      model: null,
      permissionMode: 'default',
      status: 'waiting',
      slug: 's1',
      pendingMessage: null,
      directories: [
        {
          path: app,
          kind: 'clone',
          repositoryId: 'r-app',
          branch: 'claude/s1',
          baseBranch: 'main',
          state: 'ready',
          setupStatus: 'none',
        },
        {
          path: lib,
          kind: 'clone',
          repositoryId: 'r-lib',
          branch: 'claude/s1',
          baseBranch: 'main',
          state: 'ready',
          setupStatus: 'none',
        },
      ],
    });
    sessions.updateDirectory('s1', 0, { baseCommit: baseApp });
    sessions.updateDirectory('s1', 1, { baseCommit: baseLib });
  });

  afterEach(() => {
    db.$client.close();
    sandbox.cleanup();
  });

  it('lists nothing for unchanged clones', async () => {
    expect(await files()).toEqual([
      { repository: 'acme/app', state: 'ok', files: [] },
      { repository: 'acme/lib', state: 'ok', files: [] },
    ]);
  });

  it('includes commits, uncommitted and untracked changes of every clone', async () => {
    // Committed in the session.
    await commitFile(app, 'committed.md', '# New\n');
    // Uncommitted change, rename (not staged), deletion.
    const main = await readFile(join(app, 'src', 'main.ts'), 'utf8');
    await writeFile(
      join(app, 'src', 'main.ts'),
      main.replace('line 15\n', 'line fifteen\n'),
    );
    await rename(join(app, 'old-name.txt'), join(app, 'new-name.txt'));
    await rm(join(app, 'gone.txt'));
    // Untracked; ignored files stay out.
    await writeFile(join(app, 'untracked.txt'), 'u\n');
    await mkdir(join(app, 'dist'));
    await writeFile(join(app, 'dist', 'bundle.js'), 'ignored');
    // Binary and an odd name in the other repository, staged.
    await writeFile(join(lib, 'image.bin'), Buffer.from([0, 1, 2, 255, 0]));
    await writeFile(join(lib, 'odd "name"\twith\ttabs\n.txt'), 'odd\n');
    await git(lib, 'add', '.');
    const indexBefore = await readFile(join(app, '.git', 'index'));

    const diff = await service.sessionDiff('s1');
    const [appDiff, libDiff] = diff.repositories;
    expect(appDiff).toMatchObject({
      repositoryId: 'r-app',
      repository: 'acme/app',
      path: app,
      branch: 'claude/s1',
      baseBranch: 'main',
      startCommit: baseApp,
      // These clones have no origin: compared against the start commit.
      comparison: {
        commit: baseApp,
        basis: 'start_commit',
        ref: null,
        fallbackReason: 'The clone does not know origin/main.',
      },
      headCommit: await git(app, 'rev-parse', 'HEAD'),
      state: 'ok',
      fileCount: 5,
    });
    const byPath = new Map<string, SessionDiffFile>(
      appDiff.files.map((file) => [file.path, file]),
    );
    expect([...byPath.keys()].sort()).toEqual([
      'committed.md',
      'gone.txt',
      'new-name.txt',
      'src/main.ts',
      'untracked.txt',
    ]);
    expect(byPath.get('committed.md')).toMatchObject({
      status: 'added',
      additions: 1,
      content: 'included',
      hunks: [{ lines: ['+# New'] }],
    });
    expect(byPath.get('new-name.txt')).toMatchObject({
      status: 'renamed',
      oldPath: 'old-name.txt',
      additions: 0,
      deletions: 0,
      hunks: [],
    });
    expect(byPath.get('gone.txt')).toMatchObject({
      status: 'deleted',
      deletions: 1,
    });
    expect(byPath.get('src/main.ts')).toMatchObject({
      status: 'modified',
      additions: 1,
      deletions: 1,
      hunks: [
        {
          oldStart: 12,
          newStart: 12,
          lines: [
            ' line 12',
            ' line 13',
            ' line 14',
            '-line 15',
            '+line fifteen',
            ' line 16',
            ' line 17',
            ' line 18',
          ],
        },
      ],
    });
    expect(byPath.get('untracked.txt')).toMatchObject({
      status: 'added',
      hunks: [{ lines: ['+u'] }],
    });
    expect(appDiff).toMatchObject({ additions: 3, deletions: 2 });

    expect(libDiff.files).toEqual([
      expect.objectContaining({
        path: 'image.bin',
        status: 'added',
        binary: true,
        hunks: [],
      }),
      expect.objectContaining({
        path: 'odd "name"\twith\ttabs\n.txt',
        status: 'added',
        hunks: [expect.objectContaining({ lines: ['+odd'] })],
      }),
    ]);

    // The clone's index and git directory are left as they were.
    expect(await readFile(join(app, '.git', 'index'))).toEqual(indexBefore);
    expect(
      readdirSync(join(app, '.git')).filter((name) => name.startsWith('crm-')),
    ).toEqual([]);
    expect(await git(app, 'status', '--porcelain')).toContain(
      '?? untracked.txt',
    );
  });

  it('loads single files, also odd names and renames', async () => {
    await writeFile(join(lib, 'odd "name"\twith\ttabs\n.txt'), 'odd\n');
    await rename(join(app, 'old-name.txt'), join(app, 'moved.txt'));
    await writeFile(join(app, 'moved.txt'), 'changed\n', { flag: 'a' });
    expect(
      await service.fileDiff(
        's1',
        'r-lib',
        'odd "name"\twith\ttabs\n.txt',
        null,
      ),
    ).toMatchObject({ status: 'added', additions: 1, content: 'included' });
    expect(
      await service.fileDiff('s1', 'r-app', 'moved.txt', 'old-name.txt'),
    ).toMatchObject({
      status: 'renamed',
      oldPath: 'old-name.txt',
      additions: 1,
      hunks: [
        expect.objectContaining({
          lines: expect.arrayContaining(['+changed']),
        }),
      ],
    });
    await expect(
      service.fileDiff('s1', 'r-app', 'unchanged.txt', null),
    ).rejects.toThrow('has no changes');
    await expect(service.fileDiff('s1', 'r-other', 'x', null)).rejects.toThrow(
      'not part of session',
    );
    // Pathspec magic is taken literally.
    await expect(
      service.fileDiff('s1', 'r-app', ':(glob)*', null),
    ).rejects.toThrow('has no changes');
  });

  it('limits large diffs and says what it left out', async () => {
    service.limits = {
      maxFiles: 3,
      maxFileLines: 50,
      maxTotalLines: 120,
      maxSingleFileLines: 200,
    };
    const lines = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join('\n') +
      '\n';
    await writeFile(join(app, 'a-small.txt'), lines(10, 'a'));
    await writeFile(join(app, 'b-huge.txt'), lines(500, 'b'));
    await writeFile(join(app, 'c-medium.txt'), lines(45, 'c'));
    await writeFile(join(app, 'd-more.txt'), lines(40, 'd'));
    await writeFile(join(lib, 'e-lib.txt'), lines(45, 'e'));
    await writeFile(join(lib, 'f-lib.txt'), lines(45, 'f'));

    const diff = await service.sessionDiff('s1');
    const [appDiff, libDiff] = diff.repositories;
    expect(diff.limits).toEqual(service.limits);
    expect(appDiff.fileCount).toBe(4);
    expect(appDiff.additions).toBe(595);
    expect(
      appDiff.files.map((file) => [
        file.path,
        file.content,
        file.hunks.length > 0,
      ]),
    ).toEqual([
      ['a-small.txt', 'included', true],
      ['b-huge.txt', 'too_large', false],
      ['c-medium.txt', 'included', true],
    ]);
    // The total budget ran out in the second repository.
    expect(libDiff.files.map((file) => [file.path, file.content])).toEqual([
      ['e-lib.txt', 'included'],
      ['f-lib.txt', 'omitted'],
    ]);
    // Alone, a file shows up to its own limit.
    const huge = await service.fileDiff('s1', 'r-app', 'b-huge.txt', null);
    expect(huge).toMatchObject({
      content: 'included',
      truncated: true,
      additions: 500,
    });
    expect(huge.hunks.flatMap((hunk) => hunk.lines)).toHaveLength(200);
    expect(SESSION_DIFF_LIMITS.maxFiles).toBeGreaterThan(100);
  });

  it('removes temporary indexes left over by a stopped server', async () => {
    const stale = join(app, '.git', 'crm-diff-0123456789abcdef.index');
    const fresh = join(app, '.git', 'crm-diff-fedcba9876543210.index');
    await writeFile(stale, 'x');
    await writeFile(fresh, 'x');
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(stale, hourAgo, hourAgo);
    await service.sessionDiff('s1');
    expect(existsSync(stale)).toBe(false);
    // Possibly a diff that is running right now.
    expect(existsSync(fresh)).toBe(true);
  });

  it('reports clones it cannot diff', async () => {
    sessions.updateDirectory('s1', 1, { state: 'removed' });
    await rm(join(app, '.git'), { recursive: true });
    const diff = await service.sessionDiff('s1');
    expect(diff.repositories.map((repository) => repository.state)).toEqual([
      'unavailable',
      'unavailable',
    ]);
    expect(diff.repositories[0].message).toContain('git could not compute');
    expect(diff.repositories[1].message).toContain('removed');
    expect(existsSync(app)).toBe(true);
  });
});

describe('git diff parsing', () => {
  it('reads raw and numstat records with -z', () => {
    const output = [
      ':100644 100644 aaa bbb M',
      'src/a.ts',
      ':100644 100644 ccc ccc R100',
      'old\tname',
      'new\nname',
      ':000000 100644 000 ddd A',
      'bin',
      '3\t1\tsrc/a.ts',
      '0\t0\t',
      'old\tname',
      'new\nname',
      '-\t-\tbin',
      '',
    ].join('\0');
    expect(parseRawNumstat(output)).toEqual([
      {
        path: 'src/a.ts',
        oldPath: null,
        status: 'modified',
        binary: false,
        additions: 3,
        deletions: 1,
      },
      {
        path: 'new\nname',
        oldPath: 'old\tname',
        status: 'renamed',
        binary: false,
        additions: 0,
        deletions: 0,
      },
      {
        path: 'bin',
        oldPath: null,
        status: 'added',
        binary: true,
        additions: 0,
        deletions: 0,
      },
    ]);
    expect(parseRawNumstat('')).toEqual([]);
  });

  it('splits patches into files and keeps lines within the budget', () => {
    let kept = 0;
    const parser = new PatchParser((_, fileLines) => {
      if (fileLines >= 2 || kept >= 3) {
        return false;
      }
      kept++;
      return true;
    });
    for (const line of [
      'diff --git a/x b/x',
      'index 1..2 100644',
      '--- a/x',
      '+++ b/x',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/big b/big',
      '@@ -0,0 +1,3 @@',
      '+1',
      '+2',
      '+3',
      'diff --git a/bin b/bin',
      'Binary files /dev/null and b/bin differ',
      'diff --git a/y b/y',
      '@@ -1 +1 @@',
      '+diff --git a/fake b/fake',
    ]) {
      parser.push(line);
    }
    expect(parser.patches).toEqual([
      {
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ['-old', '+new'],
          },
        ],
        lines: 2,
        additions: 1,
        deletions: 1,
        binary: false,
        dropped: false,
        truncated: false,
      },
      {
        hunks: [],
        lines: 3,
        additions: 3,
        deletions: 0,
        binary: false,
        dropped: true,
        truncated: false,
      },
      {
        hunks: [],
        lines: 0,
        additions: 0,
        deletions: 0,
        binary: true,
        dropped: false,
        truncated: false,
      },
      {
        hunks: [],
        lines: 1,
        additions: 1,
        deletions: 0,
        binary: false,
        dropped: true,
        truncated: false,
      },
    ]);
  });
});

describe('pairing files and patches', () => {
  const patchParser = () => new PatchParser(() => true, undefined, 'truncate');

  it('takes files and patches from one output, also for odd names', () => {
    const header = [
      ':100644 100644 aaa bbb M',
      'a\nb.txt',
      ':000000 100644 000 ccc A',
      'c.txt',
      '1\t1\ta\nb.txt',
      '1\t0\tc.txt',
      '',
    ].join('\0');
    const patch = [
      'diff --git "a/a\\nb.txt" "b/a\\nb.txt"',
      '--- "a/a\\nb.txt"',
      '+++ "b/a\\nb.txt"',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/c.txt b/c.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/c.txt',
      '@@ -0,0 +1 @@',
      '+c',
      '',
    ].join('\n');
    const bytes = Buffer.from(`${header}\0${patch}`);
    // Delivered in arbitrary pieces, as a pipe does.
    const patches = patchParser();
    const output = new DiffOutputParser(patches);
    for (let i = 0; i < bytes.length; i += 3) {
      output.push(bytes.subarray(i, i + 3));
    }
    output.end();
    expect(output.changes?.map((change) => change.path)).toEqual([
      'a\nb.txt',
      'c.txt',
    ]);
    expect(patches.patches.map((entry) => entry.hunks[0].lines)).toEqual([
      ['-old', '+new'],
      ['+c'],
    ]);
    expect(
      output.changes?.map(
        (change, i) => diffFile(change, patches.patches[i], 100).content,
      ),
    ).toEqual(['included', 'included']);

    const empty = new DiffOutputParser(patchParser());
    empty.end();
    expect(empty.changes).toEqual([]);
  });

  it('never shows a patch under the wrong file', () => {
    // As if the working tree changed between listing and patch: the patch
    // read for a.txt is that of another file.
    const [change] = parseRawNumstat(
      [':100644 100644 a b M', 'a.txt', '2\t0\ta.txt', ''].join('\0'),
    );
    const other: FilePatch = {
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['-x', '+y'],
        },
      ],
      lines: 2,
      additions: 1,
      deletions: 1,
      binary: false,
      dropped: false,
      truncated: false,
    };
    expect(diffFile(change, other, 100)).toMatchObject({
      path: 'a.txt',
      content: 'omitted',
      hunks: [],
    });
    expect(diffFile(change, undefined, 100).content).toBe('omitted');
  });
});

describe('SessionDiffService against the base branch', () => {
  let sandbox: ReturnType<typeof gitSandbox>;
  let db: AppDatabase;
  let sessions: SessionRepository;
  let service: SessionDiffService;
  let upstream: string;
  let clone: string;
  let start: string;

  const paths = async () =>
    (await service.sessionDiff('s1')).repositories[0].files.map(
      (file) => `${file.status} ${file.path}`,
    );

  beforeEach(async () => {
    sandbox = gitSandbox('crm-session-diff-base-');
    db = openDatabase(':memory:');
    sessions = new SessionRepository(db);
    service = new SessionDiffService(sessions);
    upstream = join(sandbox.dir, 'upstream');
    start = await createOrigin(upstream);
    clone = join(sandbox.dir, 'sessions', 's1', 'acme', 'app');
    await git(sandbox.dir, 'clone', '--quiet', '--', upstream, clone);
    await git(clone, 'switch', '--quiet', '-c', 'claude/s1');
    new RepositoryRepository(db).create({
      id: 'r-app',
      owner: 'acme',
      name: 'app',
      cloneUrl: upstream,
      localPath: join(sandbox.dir, 'repos', 'app'),
      setupScript: null,
    });
    sessions.create({
      id: 's1',
      title: null,
      model: null,
      permissionMode: 'default',
      status: 'waiting',
      slug: 's1',
      pendingMessage: null,
      directories: [
        {
          path: clone,
          kind: 'clone',
          repositoryId: 'r-app',
          branch: 'claude/s1',
          baseBranch: 'main',
          state: 'ready',
          setupStatus: 'none',
        },
      ],
    });
    sessions.updateDirectory('s1', 0, { baseCommit: start });
    // The session's work, and newer work on the base branch.
    await commitFile(clone, 'session.txt', 'mine\n');
    await commitFile(upstream, 'upstream.txt', 'theirs\n');
    await git(clone, 'fetch', '--quiet', 'origin');
  });

  afterEach(() => {
    db.$client.close();
    sandbox.cleanup();
  });

  it('leaves out base branch changes merged into the session branch', async () => {
    await git(clone, 'merge', '--quiet', '--no-edit', 'origin/main');
    const newBase = await git(clone, 'rev-parse', 'origin/main');
    await writeFile(join(clone, 'untracked.md'), 'u\n');
    expect(await paths()).toEqual(['added session.txt', 'added untracked.md']);
    expect((await service.sessionDiff('s1')).repositories[0]).toMatchObject({
      startCommit: start,
      comparison: {
        commit: newBase,
        basis: 'merge_base',
        ref: 'origin/main',
        fallbackReason: null,
      },
    });
    // Against the start commit it would include the merged file.
    expect(newBase).not.toBe(start);
  });

  it('leaves out base branch changes after a rebase', async () => {
    await git(clone, 'rebase', '--quiet', 'origin/main');
    expect(await paths()).toEqual(['added session.txt']);
    // Not merged in: the base branch's newer work is not the session's
    // either way.
    await git(clone, 'reset', '--quiet', '--hard', start);
    await commitFile(clone, 'other.txt', 'x\n');
    expect(await paths()).toEqual(['added other.txt']);
  });

  it('falls back to the start commit and says why', async () => {
    await git(clone, 'merge', '--quiet', '--no-edit', 'origin/main');
    await git(clone, 'remote', 'remove', 'origin');
    const diff = (await service.sessionDiff('s1')).repositories[0];
    expect(diff.comparison).toEqual({
      commit: start,
      basis: 'start_commit',
      ref: null,
      fallbackReason: 'The clone does not know origin/main.',
    });
    // The merged base branch work shows then.
    expect(diff.files.map((file) => file.path).sort()).toEqual([
      'session.txt',
      'upstream.txt',
    ]);

    // Unrelated histories.
    await git(clone, 'remote', 'add', 'origin', join(sandbox.dir, 'other'));
    await git(sandbox.dir, 'init', '--quiet', '--', join(sandbox.dir, 'other'));
    await commitFile(join(sandbox.dir, 'other'), 'o.txt', 'o');
    await git(clone, 'fetch', '--quiet', 'origin');
    expect(
      (await service.sessionDiff('s1')).repositories[0].comparison,
    ).toMatchObject({
      basis: 'start_commit',
      fallbackReason:
        'The session branch and origin/main have no common history.',
    });
  });
});

describe('SessionDiffService commits', () => {
  let sandbox: ReturnType<typeof gitSandbox>;
  let db: AppDatabase;
  let sessions: SessionRepository;
  let service: SessionDiffService;
  let upstream: string;
  let clone: string;
  let start: string;

  beforeEach(async () => {
    sandbox = gitSandbox('crm-session-diff-commits-');
    db = openDatabase(':memory:');
    sessions = new SessionRepository(db);
    service = new SessionDiffService(sessions);
    upstream = join(sandbox.dir, 'upstream');
    start = await createOrigin(upstream);
    clone = join(sandbox.dir, 'sessions', 's1', 'acme', 'app');
    await git(sandbox.dir, 'clone', '--quiet', '--', upstream, clone);
    await git(clone, 'switch', '--quiet', '-c', 'claude/s1');
    new RepositoryRepository(db).create({
      id: 'r-app',
      owner: 'acme',
      name: 'app',
      cloneUrl: upstream,
      localPath: join(sandbox.dir, 'repos', 'app'),
      setupScript: null,
    });
    sessions.create({
      id: 's1',
      title: null,
      model: null,
      permissionMode: 'default',
      status: 'waiting',
      slug: 's1',
      pendingMessage: null,
      directories: [
        {
          path: clone,
          kind: 'clone',
          repositoryId: 'r-app',
          branch: 'claude/s1',
          baseBranch: 'main',
          state: 'ready',
          setupStatus: 'none',
        },
      ],
    });
    sessions.updateDirectory('s1', 0, { baseCommit: start });
  });

  afterEach(() => {
    db.$client.close();
    sandbox.cleanup();
  });

  it('lists the session commits since the merge base, newest first', async () => {
    const first = await commitFile(clone, 'a.txt', 'a\n', 'First');
    await commitFile(upstream, 'upstream.txt', 'theirs\n');
    await git(clone, 'fetch', '--quiet', 'origin');
    await git(clone, 'merge', '--quiet', '--no-edit', 'origin/main');
    const merge = await git(clone, 'rev-parse', 'HEAD');
    // Uncommitted work is no commit.
    await writeFile(join(clone, 'wip.txt'), 'wip\n');

    const [repository] = (await service.sessionDiff('s1')).repositories;
    expect(repository.commitCount).toBe(2);
    expect(repository.commits?.map((commit) => commit.sha)).toEqual([
      merge,
      first,
    ]);
    expect(repository.commits?.[1]).toMatchObject({
      subject: 'First',
      files: [{ path: 'a.txt', additions: 1, deletions: 0 }],
    });
  });

  it('shows the diff of one commit against its parent', async () => {
    await writeFile(join(clone, 'README.md'), '# Test\n\nMore.\n');
    await writeFile(join(clone, 'new.txt'), 'new\n');
    await git(clone, 'add', '.');
    await git(clone, 'commit', '--quiet', '-m', 'Change two files\n\nWhy.');
    const sha = await git(clone, 'rev-parse', 'HEAD');
    // A later commit and uncommitted work do not show.
    await commitFile(clone, 'later.txt', 'later\n');
    await writeFile(join(clone, 'new.txt'), 'changed again\n');

    const diff = await service.commitDiff('s1', 'r-app', null, sha);
    expect(diff).toMatchObject({
      repositoryId: 'r-app',
      repository: 'acme/app',
      branch: 'claude/s1',
      parent: start,
      fileCount: 2,
      commit: {
        sha,
        subject: 'Change two files',
        body: 'Why.',
        fileCount: 2,
        additions: 3,
        deletions: 0,
      },
    });
    expect(
      diff.files.map((file) => ({
        path: file.path,
        status: file.status,
        lines: file.hunks.flatMap((hunk) => hunk.lines),
      })),
    ).toEqual([
      {
        path: 'README.md',
        status: 'modified',
        lines: [' # Test', '+', '+More.'],
      },
      { path: 'new.txt', status: 'added', lines: ['+new'] },
    ]);

    const file = await service.commitFileDiff(
      's1',
      'r-app',
      'claude/s1',
      sha,
      'new.txt',
      null,
    );
    expect(file).toMatchObject({ path: 'new.txt', content: 'included' });
    await expect(
      service.commitFileDiff('s1', 'r-app', null, sha, 'later.txt', null),
    ).rejects.toThrow('later.txt has no changes in this commit');
  });

  it('diffs a root commit against the empty tree', async () => {
    const diff = await service.commitDiff('s1', 'r-app', null, start);
    expect(diff.parent).toBeNull();
    expect(diff.files.map((file) => `${file.status} ${file.path}`)).toEqual([
      'added README.md',
    ]);
  });

  it('rejects commit IDs that are not full IDs or not in the clone', async () => {
    await expect(
      service.commitDiff('s1', 'r-app', null, 'HEAD'),
    ).rejects.toThrow('sha must be a full commit ID');
    await expect(
      service.commitDiff('s1', 'r-app', null, '--output=/tmp/x'),
    ).rejects.toThrow('sha must be a full commit ID');
    await expect(
      service.commitDiff('s1', 'r-app', null, 'a'.repeat(40)),
    ).rejects.toThrow(`The clone has no commit ${'a'.repeat(40)}`);
    await expect(
      service.commitDiff('s1', 'r-other', null, start),
    ).rejects.toThrow('Repository r-other is not part of session s1');
    sessions.updateDirectory('s1', 0, { state: 'removed' });
    await expect(
      service.commitDiff('s1', 'r-app', null, start),
    ).rejects.toThrow('The clone is not available (removed).');
  });
});
