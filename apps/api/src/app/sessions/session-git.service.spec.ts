import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import type { SessionDto } from '@claude-remote-manager/shared-types';
import { commitFile, git } from '../git/testing/git-fixtures';
import type { FakeRepository } from '../github/testing/fake-github';
import { WorkspaceHarness } from '../workspaces/testing/workspace-harness';
import { SessionGitService } from './session-git.service';

describe('SessionGitService', () => {
  let harness: WorkspaceHarness;
  let service: SessionGitService;
  let changed: string[];

  beforeEach(async () => {
    harness = new WorkspaceHarness();
    await harness.start();
    service = new SessionGitService(
      harness.sessions,
      harness.repositoryRecords,
      harness.credentials,
      harness.git,
      harness.github.service,
    );
    changed = [];
    service.changes$.subscribe((id) => changed.push(id));
  });
  afterEach(() => harness.close());

  /**
   * A repository registered from (fake) GitHub whose remote is a local
   * repository, so pushes are real.
   */
  const githubRepository = async () => {
    const repository = await harness.addRepository('alice', 'app');
    const installation = harness.github.addInstallation('alice');
    const remote = harness.github.addRepository(installation, 'app');
    harness.repositoryRecords.update(repository.id, {
      githubRepositoryId: remote.id,
      githubInstallationId: installation.id,
    });
    // GitHub knows a head branch when the remote has it.
    harness.github.headExists = (_: FakeRepository, head: string) => {
      try {
        execFileSync('git', ['rev-parse', '--verify', `refs/heads/${head}`], {
          cwd: repository.origin,
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    };
    return { ...repository, remote };
  };

  const startSession = async (repositoryId: string): Promise<SessionDto> => {
    const session = await harness.service.create({
      prompt: 'Work',
      title: 'Improve the app',
      repositories: [{ repositoryId }],
    });
    await harness.prepared(session.id);
    return harness.service.get(session.id);
  };

  it('pushes the session branch with a write token for the repository', async () => {
    const repository = await githubRepository();
    const session = await startSession(repository.id);
    const commit = await commitFile(session.cwd, 'work.txt', 'w');

    expect(await service.push(session.id, repository.id)).toBe(commit);

    expect(
      await git(
        repository.origin,
        'rev-parse',
        `refs/heads/claude/${session.slug}`,
      ),
    ).toBe(commit);
    const token = harness.github.tokens.at(-1);
    expect(token).toMatchObject({
      repositoryIds: [repository.remote.id],
      permissions: { contents: 'write' },
    });
    expect(harness.service.get(session.id).directories[0]).toMatchObject({
      pushedCommit: commit,
      pushedAt: expect.any(String),
    });
    expect(changed).toContain(session.id);
    // Nothing of the token is left in the clone.
    const config = await git(session.cwd, 'config', '--list', '--local');
    expect(config).not.toContain(token?.token ?? 'x');
  });

  it('asks for the workflows permission only when workflow files change', async () => {
    const repository = await githubRepository();
    const session = await startSession(repository.id);
    await mkdir(join(session.cwd, '.github', 'workflows'), { recursive: true });
    await commitFile(session.cwd, '.github/workflows/ci.yml', 'on: push');
    await service.push(session.id, repository.id);
    expect(harness.github.tokens.at(-1)?.permissions).toEqual({
      contents: 'write',
      workflows: 'write',
    });
  });

  it('explains pushes that are not fast-forwards and branches without commits', async () => {
    const repository = await githubRepository();
    const session = await startSession(repository.id);
    await expect(service.push(session.id, repository.id)).resolves.toMatch(
      /^[0-9a-f]{40}$/,
    );
    // Someone else pushed to the session branch meanwhile.
    await git(repository.origin, 'branch', '--', 'claude/x');
    await git(
      repository.origin,
      'checkout',
      '--quiet',
      `claude/${session.slug}`,
    );
    await commitFile(repository.origin, 'other.txt', 'o');
    await git(repository.origin, 'checkout', '--quiet', 'main');
    await commitFile(session.cwd, 'mine.txt', 'm');
    await expect(service.push(session.id, repository.id)).rejects.toThrow(
      'fetch and merge',
    );
  });

  it('creates pull requests by button, pushing first, and stores them', async () => {
    const repository = await githubRepository();
    const session = await startSession(repository.id);
    await commitFile(session.cwd, 'work.txt', 'w');

    const pull = await service.createPullRequest(
      session.id,
      repository.id,
      { body: 'Details' },
      'user',
    );

    expect(pull).toMatchObject({
      repository: 'alice/app',
      number: 1,
      title: 'Improve the app',
      state: 'open',
      headBranch: `claude/${session.slug}`,
      baseBranch: 'main',
      createdBy: 'user',
      url: 'https://github.com/alice/app/pull/1',
    });
    expect(harness.github.pulls[0]).toMatchObject({ body: 'Details' });
    expect(harness.github.tokens.at(-1)?.permissions).toEqual({
      pull_requests: 'write',
    });
    expect(harness.service.get(session.id).pullRequests).toEqual([pull]);

    // The same branch again: the open pull request is returned.
    const again = await service.createPullRequest(
      session.id,
      repository.id,
      {},
      'claude',
    );
    expect(again.id).toBe(pull.id);
    expect(again.createdBy).toBe('user');
  });

  it('does not push for Claude and says what is missing', async () => {
    const repository = await githubRepository();
    const session = await startSession(repository.id);
    await commitFile(session.cwd, 'work.txt', 'w');
    await expect(
      service.createPullRequest(
        session.id,
        repository.id,
        { title: 'T' },
        'claude',
      ),
    ).rejects.toThrow('push it first');
    expect(harness.github.pulls).toHaveLength(0);
  });

  it('refreshes the state of open pull requests', async () => {
    const repository = await githubRepository();
    const session = await startSession(repository.id);
    await commitFile(session.cwd, 'work.txt', 'w');
    await service.createPullRequest(session.id, repository.id, {}, 'user');
    harness.github.pulls[0].state = 'closed';
    harness.github.pulls[0].merged = true;

    await service.refreshPullRequests(session.id);
    expect(harness.service.get(session.id).pullRequests[0].state).toBe('open');
    await service.refreshPullRequests(session.id, true);
    expect(harness.service.get(session.id).pullRequests[0]).toMatchObject({
      state: 'merged',
      mergedAt: expect.any(String),
    });
  });

  it('pushes repositories registered by URL with the server credentials', async () => {
    const repository = await harness.addRepository('acme', 'plain');
    const session = await startSession(repository.id);
    const commit = await commitFile(session.cwd, 'work.txt', 'w');
    await service.push(session.id, repository.id);
    expect(
      await git(
        repository.origin,
        'rev-parse',
        `refs/heads/claude/${session.slug}`,
      ),
    ).toBe(commit);
    expect(harness.github.tokens).toHaveLength(0);
    await expect(
      service.createPullRequest(session.id, repository.id, {}, 'user'),
    ).rejects.toThrow('registered from GitHub');
  });

  it('has nothing to push for local projects', async () => {
    const session = await harness.service.create({
      prompt: 'Work',
      newProject: { name: 'tool' },
    });
    await harness.prepared(session.id);
    const repositoryId = harness.service.get(session.id).directories[0]
      .repository?.id as string;
    await expect(service.push(session.id, repositoryId)).rejects.toThrow(
      ConflictException,
    );
    await expect(service.push(session.id, repositoryId)).rejects.toThrow(
      'local project',
    );
  });

  it('validates requests', async () => {
    const repository = await githubRepository();
    const session = await startSession(repository.id);
    await expect(
      service.createPullRequest(
        session.id,
        repository.id,
        { base: '../x' },
        'user',
      ),
    ).rejects.toThrow('valid branch name');
    await expect(
      service.createPullRequest(
        session.id,
        repository.id,
        { draft: 'yes' as unknown as boolean },
        'user',
      ),
    ).rejects.toThrow('draft');
    await expect(
      service.push(session.id, '7d0a3c2e-1b4f-4e6a-9c8d-2f1e0a9b8c7d'),
    ).rejects.toThrow('has no clone');
  });
});
