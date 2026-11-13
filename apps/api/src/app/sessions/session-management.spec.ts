import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CleanupChoice,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { commitFile, git } from '../git/testing/git-fixtures';
import { WorkspaceEntries } from '../workspaces/workspace-entries';
import { WorkspaceHarness } from '../workspaces/testing/workspace-harness';
import { SessionManagementService } from './session-management.service';
import { SessionEventRepository } from './session-event.repository';
import { resultMessage, waitFor } from './testing/fake-agent';
import { UsageRepository } from './usage.repository';

describe('SessionManagementService', () => {
  let harness: WorkspaceHarness;
  let management: SessionManagementService;
  let repository: { id: string; origin: string; localPath: string };
  const previousConfigDir = process.env['CLAUDE_CONFIG_DIR'];

  beforeEach(async () => {
    harness = new WorkspaceHarness();
    await harness.start();
    process.env['CLAUDE_CONFIG_DIR'] = join(harness.dir, 'claude');
    repository = await harness.addRepository('acme', 'app');
    management = new SessionManagementService(
      harness.config,
      harness.db,
      harness.service,
      harness.sessions,
      harness.repositoryRecords,
      harness.sessionGit,
      harness.git,
      new WorkspaceEntries(harness.config),
      new UsageRepository(harness.db),
      harness.transcripts,
      undefined,
      harness.shownFiles,
    );
  });

  afterEach(async () => {
    process.env['CLAUDE_CONFIG_DIR'] = previousConfigDir;
    if (previousConfigDir === undefined) {
      delete process.env['CLAUDE_CONFIG_DIR'];
    }
    await harness.close();
  });

  /** A session whose first turn ended (it waits for a message). */
  const idleSession = async (
    request: Record<string, unknown> = {
      repositories: [{ repositoryId: repository.id }],
    },
  ): Promise<SessionDto> => {
    const created = await harness.service.create({
      prompt: 'Work',
      title: 'Some work',
      ...request,
    });
    await harness.prepared(created.id);
    harness.runner.last.emit(resultMessage(10, 0.01));
    await waitFor(
      () => harness.service.get(created.id).waitingFor === 'message',
    );
    return harness.service.get(created.id);
  };

  const endedSession = async (request?: Record<string, unknown>) => {
    const session = await idleSession(request);
    await harness.service.end(session.id);
    return harness.service.get(session.id);
  };

  const cleanup = (sessionId: string, ...choices: CleanupChoice[]) =>
    management.cleanup(sessionId, { directories: choices });

  describe('cleanup', () => {
    it('pushes the session branch, removes the clone and says the session cannot continue', async () => {
      const session = await endedSession();
      const commit = await commitFile(session.cwd, 'work.txt', 'w');

      const preview = await management.cleanupPreview(session.id);
      expect(preview.blocked).toBeNull();
      expect(preview.directories).toEqual([
        expect.objectContaining({
          position: 0,
          name: 'acme/app',
          actions: ['push', 'discard', 'keep'],
          hasCommits: true,
          loss: expect.objectContaining({ clean: false, unpushedCount: 1 }),
          // After the push nothing would be left.
          lossAfterIntegration: expect.objectContaining({ clean: true }),
        }),
      ]);

      const result = await cleanup(session.id, { position: 0, action: 'push' });
      expect(result.outcomes).toEqual([
        expect.objectContaining({ result: 'removed', action: 'push' }),
      ]);
      expect(
        await git(repository.origin, 'rev-parse', `claude/${session.slug}`),
      ).toBe(commit);
      expect(existsSync(session.cwd)).toBe(false);
      expect(
        existsSync(join(harness.config.sessionsDir, session.slug ?? '')),
      ).toBe(false);
      expect(result.session.directories[0].state).toBe('removed');
      await expect(
        harness.service.send(session.id, { text: 'more' }),
      ).rejects.toThrow('not available');
      const notice = new SessionEventRepository(harness.db)
        .list(session.id)
        .map(({ event }) => event)
        .find(
          (event) =>
            event.type === 'notice' && event.text.startsWith('Cleanup'),
        );
      expect(notice).toMatchObject({
        text: expect.stringContaining('no longer continued'),
      });
    });

    it('keeps a clone that would still lose uncommitted work after the push', async () => {
      const session = await endedSession();
      await commitFile(session.cwd, 'work.txt', 'w');
      await writeFile(join(session.cwd, 'draft.txt'), 'not committed');

      const preview = await management.cleanupPreview(session.id);
      expect(preview.directories[0].lossAfterIntegration).toMatchObject({
        files: ['draft.txt'],
        unpushedCount: 0,
      });
      const kept = await cleanup(session.id, { position: 0, action: 'push' });
      expect(kept.outcomes[0]).toMatchObject({ result: 'kept' });
      expect(kept.outcomes[0].message).toContain('1 uncommitted file');
      expect(existsSync(join(session.cwd, 'draft.txt'))).toBe(true);

      const removed = await cleanup(session.id, {
        position: 0,
        action: 'push',
        acceptLoss: true,
      });
      expect(removed.outcomes[0]).toMatchObject({ result: 'removed' });
      expect(existsSync(session.cwd)).toBe(false);
    });

    it('discards a dirty clone only after the loss was accepted', async () => {
      const session = await endedSession();
      await commitFile(session.cwd, 'work.txt', 'w');
      await git(session.cwd, 'stash', 'list');
      await writeFile(join(session.cwd, 'scratch.txt'), 'x');
      await git(session.cwd, 'stash', 'push', '--include-untracked', '--quiet');

      const refused = await cleanup(session.id, {
        position: 0,
        action: 'discard',
      });
      expect(refused.outcomes[0].result).toBe('kept');
      expect(refused.outcomes[0].message).toMatch(
        /1 commit not on the remote, 1 stash entry/,
      );
      expect(existsSync(session.cwd)).toBe(true);

      const done = await cleanup(session.id, {
        position: 0,
        action: 'discard',
        acceptLoss: true,
      });
      expect(done.outcomes[0].result).toBe('removed');
      expect(existsSync(session.cwd)).toBe(false);
    });

    it('fast-forwards the base branch of a local project', async () => {
      const session = await endedSession({ newProject: { name: 'tool' } });
      const project = session.directories[0];
      expect(
        (await management.cleanupPreview(session.id)).directories[0].actions,
      ).toEqual(['merge', 'discard', 'keep']);
      const commit = await commitFile(project.path, 'tool.txt', 'v1');

      const result = await cleanup(session.id, {
        position: 0,
        action: 'merge',
      });
      expect(result.outcomes[0]).toMatchObject({ result: 'removed' });
      const mirror = harness.repositoryRecords.require(
        project.repository?.id ?? '',
      ).localPath;
      expect(await git(mirror, 'rev-parse', 'refs/heads/main')).toBe(commit);
      expect(existsSync(project.path)).toBe(false);
    });

    it('keeps the clone when the base branch moved on', async () => {
      const first = await endedSession({ newProject: { name: 'tool' } });
      const repositoryId = first.directories[0].repository?.id ?? '';
      const second = await endedSession({
        repositories: [{ repositoryId }],
      });
      await commitFile(first.cwd, 'a.txt', 'a');
      await commitFile(second.cwd, 'b.txt', 'b');
      await cleanup(first.id, { position: 0, action: 'merge' });

      const result = await cleanup(second.id, { position: 0, action: 'merge' });
      expect(result.outcomes[0].result).toBe('failed');
      expect(result.outcomes[0].message).toContain(
        'merge main into the session branch first',
      );
      expect(existsSync(join(second.cwd, 'b.txt'))).toBe(true);
    });

    it('refuses while a turn runs and before the session ended', async () => {
      const session = await idleSession();
      await harness.service.send(session.id, { text: 'go on' });
      await expect(
        cleanup(session.id, { position: 0, action: 'discard' }),
      ).rejects.toThrow('stop it first');
      harness.runner.last.emit(resultMessage(20, 0.02));
      await waitFor(
        () => harness.service.get(session.id).waitingFor === 'message',
      );
      await expect(
        cleanup(session.id, { position: 0, action: 'discard' }),
      ).rejects.toThrow('End the session');
      expect((await management.cleanupPreview(session.id)).blocked).toContain(
        'End the session',
      );
    });

    it('never deletes outside the session when the database points elsewhere', async () => {
      const session = await endedSession();
      const outside = join(harness.dir, 'precious');
      mkdirSync(outside);
      writeFileSync(join(outside, 'keep.txt'), 'keep');
      harness.db.$client
        .prepare('UPDATE session_directories SET path = ? WHERE session_id = ?')
        .run(outside, session.id);

      const result = await cleanup(session.id, {
        position: 0,
        action: 'discard',
        acceptLoss: true,
      });
      expect(result.outcomes[0].result).toBe('failed');
      expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    });

    it('cleans up a scratch directory, showing its files first', async () => {
      const session = await endedSession({ scratch: true });
      await writeFile(join(session.cwd, 'notes.md'), '# notes');
      const preview = await management.cleanupPreview(session.id);
      expect(preview.directories[0]).toMatchObject({
        kind: 'scratch',
        actions: ['discard', 'keep'],
        loss: { files: ['notes.md'], fileCount: 1, clean: false },
      });
      const result = await cleanup(session.id, {
        position: 0,
        action: 'discard',
        acceptLoss: true,
      });
      expect(result.outcomes[0].result).toBe('removed');
      expect(existsSync(session.cwd)).toBe(false);
    });

    it('validates the choices', async () => {
      const session = await endedSession();
      for (const body of [
        {},
        { directories: 'all' },
        { directories: [{ position: -1, action: 'discard' }] },
        { directories: [{ position: 0, action: 'burn' }] },
        {
          directories: [
            { position: 0, action: 'keep' },
            { position: 0, action: 'discard' },
          ],
        },
      ]) {
        await expect(management.cleanup(session.id, body)).rejects.toThrow();
      }
      expect(existsSync(session.cwd)).toBe(true);
    });
  });

  describe('archive', () => {
    it('ends, cleans up and hides the session; unarchive shows it again', async () => {
      const session = await idleSession();
      const result = await management.archive(session.id, {
        cleanup: [{ position: 0, action: 'discard' }],
      });
      expect(result.session).toMatchObject({
        status: 'finished',
        archivedAt: expect.any(String),
      });
      expect(result.outcomes[0].result).toBe('removed');
      expect(harness.service.list().map((entry) => entry.id)).not.toContain(
        session.id,
      );
      expect(harness.service.list('only').map((entry) => entry.id)).toEqual([
        session.id,
      ]);
      await expect(
        harness.service.send(session.id, { text: 'x' }),
      ).rejects.toThrow('archived');
      await expect(management.archive(session.id, {})).rejects.toThrow(
        'archived already',
      );

      expect(management.unarchive(session.id).archivedAt).toBeNull();
      expect(harness.service.list().map((entry) => entry.id)).toContain(
        session.id,
      );
    });

    it('keeps everything without cleanup choices, and the session can continue after unarchiving', async () => {
      const session = await idleSession();
      await management.archive(session.id, {});
      expect(existsSync(session.cwd)).toBe(true);
      management.unarchive(session.id);
      await harness.service.send(session.id, { text: 'continue' });
      expect(harness.service.get(session.id).status).toBe('running');
      await waitFor(() => harness.runner.runs.length === 2);
    });
  });

  describe('delete', () => {
    it('is refused for a session that is not ended or archived', async () => {
      const session = await idleSession();
      expect((await management.deletionPreview(session.id)).blocked).toContain(
        'end or archive',
      );
      await expect(
        management.delete(session.id, { confirm: true }),
      ).rejects.toThrow('end or archive');
    });

    it('needs the loss accepted, then removes everything but the usage', async () => {
      const session = await endedSession();
      await writeFile(join(session.cwd, 'draft.txt'), 'x');
      const claude = join(harness.dir, 'claude');
      const transcript = join(
        claude,
        'projects',
        'some-project',
        `${session.id}.jsonl`,
      );
      mkdirSync(join(claude, 'projects', 'some-project'), { recursive: true });
      writeFileSync(transcript, '{}\n');
      mkdirSync(join(claude, 'file-history', session.id), { recursive: true });

      const preview = await management.deletionPreview(session.id);
      expect(preview).toMatchObject({
        blocked: null,
        directories: [expect.objectContaining({ name: 'acme/app' })],
        usage: expect.objectContaining({ costUsd: 0.01 }),
      });
      await expect(management.delete(session.id, {})).rejects.toThrow(
        'confirm',
      );
      await expect(
        management.delete(session.id, { confirm: true }),
      ).rejects.toThrow('would lose work in acme/app');
      expect(existsSync(session.cwd)).toBe(true);

      const deleted: string[] = [];
      harness.service.deletions$.subscribe((id) => deleted.push(id));
      await management.delete(session.id, { confirm: true, acceptLoss: true });
      expect(deleted).toEqual([session.id]);
      expect(existsSync(session.cwd)).toBe(false);
      expect(existsSync(transcript)).toBe(false);
      expect(existsSync(join(claude, 'file-history', session.id))).toBe(false);
      expect(harness.sessions.get(session.id)).toBeUndefined();
      expect(() => harness.service.get(session.id)).toThrow('not found');
      expect(
        harness.db.$client
          .prepare('SELECT title, repositories FROM deleted_sessions')
          .all(),
      ).toEqual([{ title: 'Some work', repositories: '["acme/app"]' }]);
      expect(
        harness.db.$client
          .prepare(
            'SELECT count(*) AS n FROM usage_records WHERE session_id = ?',
          )
          .get(session.id),
      ).toEqual({ n: 1 });
    });

    it('deletes an archived session whose clones were cleaned up', async () => {
      const session = await idleSession();
      await management.archive(session.id, {
        cleanup: [{ position: 0, action: 'discard' }],
      });
      const preview = await management.deletionPreview(session.id);
      expect(preview.directories).toEqual([]);
      await management.delete(session.id, { confirm: true });
      expect(harness.sessions.get(session.id)).toBeUndefined();
    });
  });

  describe('rename', () => {
    it('changes the title only', async () => {
      const session = await idleSession();
      const renamed = await harness.service.update(session.id, {
        title: '  Better name ',
      });
      expect(renamed).toMatchObject({
        title: 'Better name',
        slug: session.slug,
        cwd: session.cwd,
      });
      expect(renamed.directories[0].branch).toBe(`claude/${session.slug}`);
      await expect(
        harness.service.update(session.id, { title: '  ' }),
      ).rejects.toThrow('blank');
      await expect(
        harness.service.update(session.id, { title: 'x'.repeat(201) }),
      ).rejects.toThrow();
    });
  });
});
