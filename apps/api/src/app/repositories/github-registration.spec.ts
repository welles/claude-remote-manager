import { ConflictException, NotFoundException } from '@nestjs/common';
import type { MirrorUpdateOptions } from '../git/git.service';
import { waitFor } from '../sessions/testing/fake-agent';
import { WorkspaceHarness } from '../workspaces/testing/workspace-harness';

describe('repositories from GitHub', () => {
  let harness: WorkspaceHarness;
  let updates: {
    path: string;
    url: string | null;
    options: MirrorUpdateOptions;
  }[];

  beforeEach(async () => {
    harness = new WorkspaceHarness();
    await harness.start();
    updates = [];
    // No network: record what the mirror update would get.
    jest
      .spyOn(harness.git, 'updateMirror')
      .mockImplementation(async (path, url, options = {}) => {
        updates.push({ path, url, options });
        return { defaultBranch: 'main', created: true };
      });
  });
  afterEach(() => harness.close());

  const setup = () => {
    const user = harness.github.addInstallation('alice');
    const org = harness.github.addInstallation('acme', 'Organization');
    return {
      user,
      app: harness.github.addRepository(user, 'app'),
      tool: harness.github.addRepository(org, 'tool', { private: false }),
      org,
    };
  };

  it('lists the repositories of all installations, searchable and paginated', async () => {
    const { app } = setup();
    const all = await harness.repositories.githubRepositories({});
    expect(all).toMatchObject({ total: 2, page: 1, perPage: 30, errors: [] });
    expect(all.repositories.map((repository) => repository.fullName)).toEqual([
      'acme/tool',
      'alice/app',
    ]);
    const found = await harness.repositories.githubRepositories({
      query: 'ALICE',
      perPage: 1,
    });
    expect(found.repositories).toEqual([
      expect.objectContaining({ id: app.id, registeredRepositoryId: null }),
    ]);
    const second = await harness.repositories.githubRepositories({
      page: 2,
      perPage: 1,
    });
    expect(
      second.repositories.map((repository) => repository.fullName),
    ).toEqual(['alice/app']);
  });

  it('registers a repository and fetches its mirror with a read token for it alone', async () => {
    const { app, user } = setup();
    const registered = await harness.repositories.registerFromGitHub(app.id);
    expect(registered).toMatchObject({
      fullName: 'alice/app',
      cloneUrl: 'https://github.com/alice/app.git',
      github: {
        repositoryId: app.id,
        installationId: user.id,
        htmlUrl: 'https://github.com/alice/app',
      },
    });
    await waitFor(() => updates.length === 1);
    const auth = await updates[0].options.auth?.();
    const header = auth?.env['GIT_CONFIG_VALUE_0'] ?? '';
    const token = Buffer.from(
      header.replace('Authorization: Basic ', ''),
      'base64',
    )
      .toString()
      .replace('x-access-token:', '');
    expect(
      harness.github.tokens.find((entry) => entry.token === token),
    ).toMatchObject({
      repositoryIds: [app.id],
      permissions: { contents: 'read' },
    });
    expect(updates[0].url).toBe('https://github.com/alice/app.git');

    // Registering again returns the same repository.
    const again = await harness.repositories.registerFromGitHub(app.id);
    expect(again.id).toBe(registered.id);
    const listed = await harness.repositories.githubRepositories({
      query: 'app',
    });
    expect(listed.repositories[0].registeredRepositoryId).toBe(registered.id);
  });

  it('links a repository registered by its https URL and refuses other URLs', async () => {
    const { app, tool } = setup();
    const plain = await harness.repositories.register({
      cloneUrl: 'https://github.com/alice/app',
    });
    const linked = await harness.repositories.registerFromGitHub(app.id);
    expect(linked.id).toBe(plain.id);
    expect(linked.github?.repositoryId).toBe(app.id);
    expect(linked.cloneUrl).toBe('https://github.com/alice/app');

    await harness.repositories.register({
      cloneUrl: 'git@github.com:acme/tool.git',
    });
    await expect(
      harness.repositories.registerFromGitHub(tool.id),
    ).rejects.toThrow(ConflictException);
  });

  it('refuses repositories the installations cannot access', async () => {
    setup();
    await expect(
      harness.repositories.registerFromGitHub(123456),
    ).rejects.toThrow(NotFoundException);
    await expect(
      harness.repositories.registerFromGitHub('12' as unknown as number),
    ).rejects.toThrow('positive integer');
  });

  it('follows a repository to its new installation', async () => {
    const { app } = setup();
    const registered = await harness.repositories.registerFromGitHub(app.id);
    await waitFor(() => updates.length === 1);
    // The app was reinstalled on the account: new installation ID.
    const moved = harness.github.addInstallation('alice');
    harness.github.installations[0].repositories = [];
    moved.repositories.push(app);
    const token = await harness.credentials.token(
      harness.repositoryRecords.require(registered.id),
      { contents: 'read' },
      { fresh: true },
    );
    expect(token.installationId).toBe(moved.id);
    expect(
      harness.repositoryRecords.require(registered.id).githubInstallationId,
    ).toBe(moved.id);
  });

  it('keeps repositories without GitHub registration on the server credentials', async () => {
    const repository = await harness.addRepository('acme', 'plain');
    expect(
      await harness.credentials.readAuth(
        harness.repositoryRecords.require(repository.id),
      ),
    ).toBeNull();
  });
});
