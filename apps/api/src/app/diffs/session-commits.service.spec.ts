import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CommitsAddedEvent,
  SessionEventInput,
} from '@claude-remote-manager/shared-types';
import { openDatabase, type AppDatabase } from '../db/database';
import {
  commitFile,
  createOrigin,
  git,
  gitSandbox,
} from '../git/testing/git-fixtures';
import * as gitRunner from '../git/git-runner';
import { RepositoryRepository } from '../repositories/repository.repository';
import { SessionRepository } from '../sessions/session.repository';
import { MAX_COMMIT_BODY, parseCommitLog } from './commit-log';
import { SessionCommitsService } from './session-commits.service';

type Added = Omit<CommitsAddedEvent, 'seq' | 'at'>;

describe('SessionCommitsService', () => {
  let sandbox: ReturnType<typeof gitSandbox>;
  let db: AppDatabase;
  let sessions: SessionRepository;
  let service: SessionCommitsService;
  let added: Added[];
  let repo: string;
  let base: string;

  const check = async (toolUseId: string | null = 'tool-1') => {
    added = [];
    await service.check('s1', toolUseId);
    return added;
  };

  /** Moves `origin/main` as a fetch would, to a new commit on main. */
  const advanceMain = async () => {
    await git(repo, 'checkout', '--quiet', 'main');
    const commit = await commitFile(repo, 'main.txt', 'main\n', 'On main');
    await git(repo, 'update-ref', 'refs/remotes/origin/main', commit);
    await git(repo, 'checkout', '--quiet', 'claude/s1');
    return commit;
  };

  beforeEach(async () => {
    sandbox = gitSandbox('crm-session-commits-');
    db = openDatabase(':memory:');
    sessions = new SessionRepository(db);
    repo = join(sandbox.dir, 'sessions', 's1', 'acme', 'app');
    base = await createOrigin(repo);
    await git(repo, 'update-ref', 'refs/remotes/origin/main', base);
    await git(repo, 'checkout', '--quiet', '-b', 'claude/s1');
    new RepositoryRepository(db).create({
      id: 'r-app',
      owner: 'acme',
      name: 'app',
      cloneUrl: null,
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
          path: repo,
          kind: 'clone',
          repositoryId: 'r-app',
          branch: 'claude/s1',
          baseBranch: 'main',
          state: 'ready',
          setupStatus: 'none',
        },
        {
          path: join(sandbox.dir, 'scratch'),
          kind: 'scratch',
          repositoryId: null,
          branch: null,
          baseBranch: null,
          state: 'ready',
          setupStatus: 'none',
        },
      ],
    });
    sessions.updateDirectory('s1', 0, { baseCommit: base });
    service = new SessionCommitsService(sessions);
    service.added$.subscribe(({ event }) => added.push(event));
  });

  afterEach(() => {
    db.$client.close();
    sandbox.cleanup();
  });

  it('reports nothing while the branch stays at its start', async () => {
    expect(await check()).toEqual([]);
  });

  it('reports a new commit once, on the tool call, with its message and files', async () => {
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\n');
    await writeFile(join(repo, 'b.bin'), Buffer.from([0, 1, 2]));
    await git(repo, 'add', '.');
    await git(
      repo,
      'commit',
      '--quiet',
      '-m',
      'feat: add files\n\nWith a body.\nOf two lines.',
    );
    const head = await git(repo, 'rev-parse', 'HEAD');

    expect(await check('tool-7')).toEqual([
      {
        type: 'commits.added',
        toolUseId: 'tool-7',
        repositoryId: 'r-app',
        repository: 'acme/app',
        branch: 'claude/s1',
        previousHead: base,
        head,
        rewritten: false,
        commitCount: 1,
        commits: [
          {
            sha: head,
            parents: [base],
            subject: 'feat: add files',
            body: 'With a body.\nOf two lines.',
            authorName: 'Test',
            authoredAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
            files: [
              {
                path: 'a.txt',
                oldPath: null,
                binary: false,
                additions: 2,
                deletions: 0,
              },
              {
                path: 'b.bin',
                oldPath: null,
                binary: true,
                additions: 0,
                deletions: 0,
              },
            ],
            fileCount: 2,
            additions: 2,
            deletions: 0,
          },
        ],
      },
    ]);
    expect(sessions.observedHeads('s1').get(0)).toBe(head);
    // Seen: not again.
    expect(await check()).toEqual([]);
  });

  it('reports several commits newest first, and only the new ones', async () => {
    const first = await commitFile(repo, 'a.txt', 'a\n', 'First');
    await check();
    const second = await commitFile(repo, 'b.txt', 'b\n', 'Second');
    const third = await commitFile(repo, 'c.txt', 'c\n', 'Third');

    const [event] = await check();
    expect(event.previousHead).toBe(first);
    expect(event.commits.map((commit) => commit.sha)).toEqual([third, second]);
    expect(event.rewritten).toBe(false);
  });

  it('reports an amended commit as a rewrite', async () => {
    const first = await commitFile(repo, 'a.txt', 'a\n', 'Fist');
    await check();
    await git(repo, 'commit', '--quiet', '--amend', '-m', 'First');

    const [event] = await check();
    expect(event).toMatchObject({
      previousHead: first,
      rewritten: true,
      commitCount: 1,
      commits: [{ subject: 'First' }],
    });
  });

  it('reports the rewritten commits of a rebase, not those of the base branch', async () => {
    await commitFile(repo, 'a.txt', 'a\n', 'Mine 1');
    await commitFile(repo, 'b.txt', 'b\n', 'Mine 2');
    await check();
    await advanceMain();
    await git(repo, 'rebase', '--quiet', 'origin/main');

    const [event] = await check();
    expect(event.rewritten).toBe(true);
    expect(event.commits.map((commit) => commit.subject)).toEqual([
      'Mine 2',
      'Mine 1',
    ]);
  });

  it('reports a merge of the base branch as the merge commit alone', async () => {
    await commitFile(repo, 'a.txt', 'a\n', 'Mine');
    await check();
    await advanceMain();
    await git(repo, 'merge', '--quiet', '--no-edit', 'origin/main');

    const [event] = await check(null);
    expect(event).toMatchObject({ toolUseId: null, rewritten: false });
    expect(event.commits).toHaveLength(1);
    expect(event.commits[0]).toMatchObject({
      subject: "Merge remote-tracking branch 'origin/main' into claude/s1",
      files: [],
      fileCount: 0,
    });
    expect(event.commits[0].parents).toHaveLength(2);
  });

  it('notes a reset to an older commit without reporting it', async () => {
    await commitFile(repo, 'a.txt', 'a\n', 'Mine');
    await check();
    await git(repo, 'reset', '--quiet', '--hard', base);

    expect(await check()).toEqual([]);
    expect(sessions.observedHeads('s1').get(0)).toBe(base);
  });

  it('only notes the branch of a directory from before the app looked', async () => {
    await commitFile(repo, 'a.txt', 'a\n', 'Before');
    sessions.setObservedHead('s1', 0, '');

    expect(await check()).toEqual([]);
    expect(sessions.observedHeads('s1').get(0)).toBe(
      await git(repo, 'rev-parse', 'HEAD'),
    );
    await commitFile(repo, 'b.txt', 'b\n', 'After');
    expect((await check()).map((event) => event.commits[0].subject)).toEqual([
      'After',
    ]);
  });

  it('only notes the branch when the commit seen last is gone', async () => {
    await commitFile(repo, 'a.txt', 'a\n', 'Mine');
    sessions.setObservedHead('s1', 0, 'f'.repeat(40));

    expect(await check()).toEqual([]);
    expect(sessions.observedHeads('s1').get(0)).toBe(
      await git(repo, 'rev-parse', 'HEAD'),
    );
  });

  it('lists the commits without their files when git cannot list those', async () => {
    const head = await commitFile(repo, 'a.txt', 'a\n', 'Mine');
    const original = gitRunner.runGit;
    const spy = jest
      .spyOn(gitRunner, 'runGit')
      .mockImplementation((args, options) =>
        args.includes('--numstat')
          ? Promise.reject(new Error('timed out'))
          : original(args, options),
      );
    try {
      const [event] = await check();
      expect(event.commits).toEqual([
        expect.objectContaining({ sha: head, subject: 'Mine', files: [] }),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('cuts very long message bodies', async () => {
    await writeFile(join(repo, 'a.txt'), 'a');
    await git(repo, 'add', '.');
    await git(
      repo,
      'commit',
      '--quiet',
      '-m',
      `Long\n\n${'x'.repeat(MAX_COMMIT_BODY + 10)}`,
    );
    const [event] = await check();
    expect(event.commits[0].body).toBe(
      `${'x'.repeat(MAX_COMMIT_BODY)}\n[… cut]`,
    );
  });

  it('skips clones that are not ready and survives a missing clone', async () => {
    await commitFile(repo, 'a.txt', 'a\n', 'Mine');
    sessions.updateDirectory('s1', 0, { state: 'removed' });
    expect(await check()).toEqual([]);
    sessions.updateDirectory('s1', 0, { state: 'ready' });
    sandbox.cleanup();
    expect(await check()).toEqual([]);
    sandbox = gitSandbox('crm-session-commits-');
  });

  describe('observe', () => {
    const results = (name: string): SessionEventInput[] => [
      {
        type: 'tool.call',
        messageId: 'm',
        toolUseId: `t-${name}`,
        name,
        input: {},
        parentToolUseId: null,
      },
      {
        type: 'tool.result',
        toolUseId: `t-${name}`,
        isError: false,
        content: '',
        truncated: false,
        parentToolUseId: null,
      },
    ];

    it('looks after tool calls that may move a branch and at the end of a turn', () => {
      const checks: (string | null)[] = [];
      service.check = (sessionId, toolUseId) => {
        checks.push(toolUseId);
        return Promise.resolve();
      };
      for (const name of ['Read', 'Edit', 'Bash', 'mcp__other__tool']) {
        for (const event of results(name)) {
          service.observe('s1', event);
        }
      }
      // A result whose call is not known (e.g. after a restart).
      service.observe('s1', results('Grep')[1]);
      service.observe('s1', {
        type: 'tool.by_app',
        toolUseId: 't-app',
        outcome: 'succeeded',
        summary: 'Committed',
      });
      service.observe('s1', {
        type: 'turn.result',
        subtype: 'success',
        isError: false,
        interrupted: false,
        durationMs: 1,
        numTurns: 1,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          costUsd: 0,
        },
        errors: [],
      });
      expect(checks).toEqual([
        't-Bash',
        't-mcp__other__tool',
        't-Grep',
        't-app',
        null,
      ]);
    });
  });
});

describe('parseCommitLog', () => {
  it('reads renames, binary files and commits without files', () => {
    const output = [
      '\x1eaaa',
      'bbb ccc',
      'Ann',
      '2026-11-26T01:02:03+01:00',
      'Merge it\n',
      '\x1ebbb',
      'ddd',
      'Bob',
      '2026-11-25T10:00:00+00:00',
      'Rename\r\n\r\nBody\r\n',
      '\n1\t0\t',
      'old name.txt',
      'new name.txt',
      '-\t-\timage.png',
      '3\t1\tsrc/\x1eodd.ts',
      '',
    ].join('\0');

    expect(parseCommitLog(output)).toEqual([
      {
        sha: 'aaa',
        parents: ['bbb', 'ccc'],
        subject: 'Merge it',
        body: '',
        authorName: 'Ann',
        authoredAt: '2026-11-26T00:02:03.000Z',
        files: [],
        fileCount: 0,
        additions: 0,
        deletions: 0,
      },
      {
        sha: 'bbb',
        parents: ['ddd'],
        subject: 'Rename',
        body: 'Body',
        authorName: 'Bob',
        authoredAt: '2026-11-25T10:00:00.000Z',
        files: [
          {
            path: 'new name.txt',
            oldPath: 'old name.txt',
            binary: false,
            additions: 1,
            deletions: 0,
          },
          {
            path: 'image.png',
            oldPath: null,
            binary: true,
            additions: 0,
            deletions: 0,
          },
          {
            path: 'src/\x1eodd.ts',
            oldPath: null,
            binary: false,
            additions: 3,
            deletions: 1,
          },
        ],
        fileCount: 3,
        additions: 4,
        deletions: 1,
      },
    ]);
  });
});
