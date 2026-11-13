import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resultMessage, waitFor } from '../sessions/testing/fake-agent';
import { WorkspaceHarness } from './testing/workspace-harness';
import { WorkspaceEntries } from './workspace-entries';
import { WorkspaceOrphansService } from './workspace-orphans.service';

describe('WorkspaceOrphansService', () => {
  let harness: WorkspaceHarness;
  let orphans: WorkspaceOrphansService;

  beforeEach(async () => {
    harness = new WorkspaceHarness();
    await harness.start();
    orphans = new WorkspaceOrphansService(
      harness.config,
      harness.sessions,
      harness.service,
      harness.git,
      new WorkspaceEntries(harness.config),
    );
  });

  afterEach(() => harness.close());

  const session = async () => {
    const repository = await harness.addRepository('acme', 'app');
    const created = await harness.service.create({
      prompt: 'Work',
      repositories: [{ repositoryId: repository.id }],
    });
    await harness.prepared(created.id);
    harness.runner.last.emit(resultMessage(1, 0));
    await waitFor(
      () => harness.service.get(created.id).waitingFor === 'message',
    );
    return harness.service.get(created.id);
  };

  /** A git clone with one commit and an uncommitted file. */
  const strayClone = (path: string) => {
    mkdirSync(path, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: path,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'T',
          GIT_AUTHOR_EMAIL: 't@example.com',
          GIT_COMMITTER_NAME: 'T',
          GIT_COMMITTER_EMAIL: 't@example.com',
        },
      });
    git('init', '-q', '-b', 'claude/gone');
    writeFileSync(join(path, 'a.txt'), 'a');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'Lost work');
    writeFileSync(join(path, 'draft.txt'), 'draft');
  };

  it('lists leftovers with what they hold and leaves used directories out', async () => {
    const used = await session();
    const clone = join(
      harness.config.sessionsDir,
      'gone-abc123',
      'acme',
      'app',
    );
    strayClone(clone);
    const scratch = join(harness.config.scratchDir, 'old-scratch');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'notes.md'), 'n');
    mkdirSync(join(harness.config.sessionsDir, 'empty-one'));
    const outside = join(harness.dir, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(harness.config.sessionsDir, 'linked'));

    const { orphans: found, missing } = await orphans.list();
    expect(found.map((entry) => entry.path).sort()).toEqual(
      [clone, scratch, join(harness.config.sessionsDir, 'empty-one')].sort(),
    );
    expect(found.find((entry) => entry.path === clone)).toMatchObject({
      kind: 'clone',
      branch: 'claude/gone',
      loss: {
        files: ['draft.txt'],
        unpushedCount: 1,
        unpushedCommits: [expect.objectContaining({ subject: 'Lost work' })],
        clean: false,
      },
    });
    expect(found.find((entry) => entry.path === scratch)).toMatchObject({
      kind: 'scratch',
      loss: { files: ['notes.md'], fileCount: 1 },
    });
    expect(missing).toEqual([]);
    expect(found.map((entry) => entry.path)).not.toContain(used.cwd);
  });

  it('removes a leftover only after the loss was accepted, and only what it listed', async () => {
    const used = await session();
    const clone = join(
      harness.config.sessionsDir,
      'gone-abc123',
      'acme',
      'app',
    );
    strayClone(clone);

    await expect(orphans.remove({ path: clone })).rejects.toThrow('confirm');
    await expect(
      orphans.remove({ path: clone, confirm: true }),
    ).rejects.toThrow('would lose work');
    for (const path of [
      used.cwd,
      harness.config.sessionsDir,
      join(clone, '..'),
      `${clone}/`,
      '/',
    ]) {
      await expect(
        orphans.remove({ path, confirm: true, acceptLoss: true }),
      ).rejects.toThrow('Not a leftover');
    }
    expect(existsSync(used.cwd)).toBe(true);

    const after = await orphans.remove({
      path: clone,
      confirm: true,
      acceptLoss: true,
    });
    expect(after.orphans).toEqual([]);
    expect(existsSync(join(harness.config.sessionsDir, 'gone-abc123'))).toBe(
      false,
    );
  });

  it('reports directories sessions expect that are gone, and marks them removed', async () => {
    const used = await session();
    await rm(used.cwd, { recursive: true, force: true });
    const { missing } = await orphans.list();
    expect(missing).toEqual([
      {
        sessionId: used.id,
        sessionTitle: used.title,
        position: 0,
        path: used.cwd,
        name: 'acme/app',
      },
    ]);
    const updated = await orphans.forgetMissing({
      sessionId: used.id,
      position: 0,
    });
    expect(updated.directories[0].state).toBe('removed');
    expect((await orphans.list()).missing).toEqual([]);
    await expect(
      orphans.forgetMissing({ sessionId: used.id, position: 0 }),
    ).rejects.toThrow('not missing');
  });
});
