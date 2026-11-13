import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabase, type AppDatabase } from '../db/database';
import { createOrigin, git, gitSandbox } from '../git/testing/git-fixtures';
import { RepositoryRepository } from '../repositories/repository.repository';
import { SessionRepository } from '../sessions/session.repository';
import {
  FileMentionsService,
  matchScore,
  mentionText,
} from './file-mentions.service';
import { SessionFileAccess } from './session-file-access';

describe('FileMentionsService', () => {
  let sandbox: ReturnType<typeof gitSandbox>;
  let db: AppDatabase;
  let service: FileMentionsService;
  let app: string;
  let lib: string;
  let scratch: string;

  beforeEach(async () => {
    sandbox = gitSandbox('crm-mentions-');
    db = openDatabase(':memory:');
    app = join(sandbox.dir, 'sessions', 's1', 'acme', 'app');
    lib = join(sandbox.dir, 'sessions', 's1', 'acme', 'lib');
    scratch = join(sandbox.dir, 'scratch', 's2');
    for (const path of [app, lib]) {
      await createOrigin(path);
      await mkdir(join(path, 'src', 'login'), { recursive: true });
      await writeFile(join(path, 'src', 'login', 'login.service.ts'), '');
      await writeFile(join(path, '.gitignore'), 'dist/\n');
      await git(path, 'add', '.');
      await git(path, 'commit', '--quiet', '-m', 'Files');
    }
    // Untracked files count, ignored ones do not.
    await writeFile(join(app, 'notes on login.md'), '');
    await mkdir(join(app, 'dist'));
    await writeFile(join(app, 'dist', 'login.js'), '');
    await mkdir(join(scratch, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(scratch, 'node_modules', 'x', 'login.js'), '');
    await writeFile(join(scratch, 'login-report.html'), '');

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
    const sessions = new SessionRepository(db);
    const base = {
      title: null,
      model: null,
      permissionMode: 'default' as const,
      status: 'waiting' as const,
      pendingMessage: null,
    };
    const clone = (path: string, repositoryId: string) => ({
      path,
      kind: 'clone' as const,
      repositoryId,
      branch: 'claude/s1',
      baseBranch: 'main',
      state: 'ready' as const,
      setupStatus: 'none' as const,
    });
    sessions.create({
      ...base,
      id: 's1',
      slug: 's1',
      directories: [clone(app, 'r-app'), clone(lib, 'r-lib')],
    });
    sessions.create({
      ...base,
      id: 's2',
      slug: 's2',
      directories: [
        {
          path: scratch,
          kind: 'scratch',
          repositoryId: null,
          branch: null,
          baseBranch: null,
          state: 'ready',
          setupStatus: 'none',
        },
      ],
    });
    service = new FileMentionsService(sessions, new SessionFileAccess());
  });

  afterEach(() => {
    db.$client.close();
    sandbox.cleanup();
  });

  it('finds files of all clones by path fragments, respecting .gitignore', async () => {
    const result = await service.search('s1', 'login');
    expect(result.files.map((file) => file.mention)).toEqual([
      '@src/login/login.service.ts',
      `@${lib}/src/login/login.service.ts`,
      '@"notes on login.md"',
    ]);
    expect(result.files[1]).toEqual({
      directory: 1,
      repository: 'acme/lib',
      path: 'src/login/login.service.ts',
      mention: `@${lib}/src/login/login.service.ts`,
    });
    expect(result.truncated).toBe(false);
    // Fragments in any order, all required.
    expect(
      (await service.search('s1', 'service src')).files.map(
        (file) => file.path,
      ),
    ).toEqual(['src/login/login.service.ts', 'src/login/login.service.ts']);
    expect((await service.search('s1', 'login nothing')).files).toEqual([]);
    // Limited.
    expect(await service.search('s1', '', 2)).toMatchObject({
      truncated: true,
    });
  });

  it('walks scratch directories without node_modules', async () => {
    expect(
      (await service.search('s2', 'login')).files.map((file) => file.mention),
    ).toEqual(['@login-report.html']);
    await expect(service.search('unknown', '')).rejects.toThrow('not found');
  });

  it('quotes mentions with spaces and ranks file names first', () => {
    expect(mentionText('a b.md')).toBe('@"a b.md"');
    expect(mentionText('src/a.ts')).toBe('@src/a.ts');
    const fragments = ['app'];
    const scores = [
      'src/app.ts',
      'app/x.ts',
      'lib/mapping.ts',
      'docs/x.md',
    ].map((path) => matchScore(path, fragments));
    // Name starts with it > name contains it > a directory starts with it.
    expect(scores[0]).toBeGreaterThan(scores[2] as number);
    expect(scores[2]).toBeGreaterThan(scores[1] as number);
    expect(scores[3]).toBeNull();
  });
});
