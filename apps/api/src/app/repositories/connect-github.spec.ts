import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { commitFile, git } from '../git/testing/git-fixtures';
import { WorkspaceHarness } from '../workspaces/testing/workspace-harness';

describe('local project to GitHub', () => {
  let harness: WorkspaceHarness;

  beforeEach(async () => {
    harness = new WorkspaceHarness();
    await harness.start();
  });
  afterEach(() => harness.close());

  /**
   * A bare repository standing in for github.com/<owner>/<name>: git
   * rewrites the GitHub URL to it, so pushes and fetches are real.
   */
  const fakeRemote = async (owner: string, name: string) => {
    const bare = join(harness.dir, 'github', owner, `${name}.git`);
    await mkdir(bare, { recursive: true });
    await git(bare, 'init', '--quiet', '--bare');
    await git(
      harness.dir,
      'config',
      '--global',
      `url.${bare}.insteadOf`,
      `https://github.com/${owner}/${name}.git`,
    );
    return bare;
  };

  /** A local project with one session that committed something. */
  const project = async () => {
    const session = await harness.service.create({
      prompt: 'Start',
      newProject: { name: 'tool' },
    });
    await harness.prepared(session.id);
    const dto = harness.service.get(session.id);
    await commitFile(dto.cwd, 'tool.txt', 'v1');
    return { session: dto, id: dto.directories[0].repository?.id as string };
  };

  it('creates the repository in an organization, pushes the project and keeps its clones', async () => {
    const org = harness.github.addInstallation('acme', 'Organization');
    const bare = await fakeRemote('acme', 'tool');
    const { session, id } = await project();
    const mirror = harness.repositoryRecords.require(id).localPath;

    const connected = await harness.repositories.connectGitHub(id, {
      mode: 'create',
      owner: 'acme',
      description: 'A tool',
    });

    const created = org.repositories.find((entry) => entry.name === 'tool');
    expect(created).toMatchObject({ private: true });
    expect(connected).toMatchObject({
      fullName: 'acme/tool',
      local: false,
      cloneUrl: 'https://github.com/acme/tool.git',
      localPath: mirror,
      defaultBranch: 'main',
      github: { repositoryId: created?.id, installationId: org.id },
      lastError: null,
    });
    // The project's main (with the initial commit) is on "GitHub" now.
    expect(await git(bare, 'rev-parse', 'main')).toBe(
      await git(mirror, 'rev-parse', 'main'),
    );
    // The push token was for the new repository only, and revoked.
    const push = harness.github.tokens.find(
      (token) => token.permissions.contents === 'write',
    );
    expect(push).toMatchObject({ repositoryIds: [created?.id] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(push?.revoked).toBe(true);
    // The existing session clone points to GitHub and stays listed.
    expect(await git(session.cwd, 'config', 'remote.origin.url')).toBe(
      'https://github.com/acme/tool.git',
    );
    expect(
      await git(session.cwd, 'config', '--get-all', 'credential.helper'),
    ).toContain('git-credential-crm');
    const listed = await harness.repositories.list();
    expect(listed.repositories[0].clones).toEqual([
      expect.objectContaining({
        path: session.cwd,
        missing: false,
        orphaned: false,
      }),
    ]);
    expect(listed.strayDirectories).toEqual([]);
    // A new session of it is an ordinary GitHub clone.
    const next = await harness.service.create({
      prompt: 'Next',
      repositories: [{ repositoryId: id }],
    });
    await harness.prepared(next.id);
    expect(harness.service.get(next.id).cwd).toContain('/acme/tool');
  });

  it('attaches an existing empty repository', async () => {
    const user = harness.github.addInstallation('alice');
    const existing = harness.github.addRepository(user, 'tool-home');
    const bare = await fakeRemote('alice', 'tool-home');
    const { id } = await project();
    const connected = await harness.repositories.connectGitHub(id, {
      mode: 'attach',
      githubRepositoryId: existing.id,
    });
    expect(connected.fullName).toBe('alice/tool-home');
    expect(await git(bare, 'branch', '--list')).toContain('main');
  });

  it('explains when a personal account repository cannot be created', async () => {
    harness.github.addInstallation('alice');
    const { id } = await project();
    await expect(
      harness.repositories.connectGitHub(id, {
        mode: 'create',
        owner: 'alice',
      }),
    ).rejects.toThrow('attach it to the project instead');
    expect(harness.repositoryRecords.require(id).cloneUrl).toBeNull();
  });

  it('refuses accounts without installation and repositories with remote', async () => {
    harness.github.addInstallation('alice');
    const { id } = await project();
    await expect(
      harness.repositories.connectGitHub(id, { mode: 'create', owner: 'bob' }),
    ).rejects.toThrow('not installed on bob');
    const plain = await harness.addRepository('acme', 'plain');
    await expect(
      harness.repositories.connectGitHub(plain.id, {
        mode: 'create',
        owner: 'alice',
      }),
    ).rejects.toThrow(ConflictException);
    await expect(
      harness.repositories.connectGitHub(id, { mode: 'other' } as never),
    ).rejects.toThrow('mode must be');
  });
});
