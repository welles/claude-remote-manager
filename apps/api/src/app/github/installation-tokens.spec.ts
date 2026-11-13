import { InstallationTokens } from './installation-tokens';
import { FakeGitHub } from './testing/fake-github';

describe('InstallationTokens', () => {
  let github: FakeGitHub;
  let repositoryId: number;
  let installationId: number;

  beforeEach(() => {
    github = new FakeGitHub();
    const installation = github.addInstallation('acme');
    installationId = installation.id;
    repositoryId = github.addRepository(installation, 'app').id;
    github.addRepository(installation, 'other');
  });

  it('mints tokens for one repository with the requested permissions', async () => {
    const token = await github.installationTokens.get({
      installationId,
      repositoryIds: [repositoryId],
      permissions: { contents: 'read' },
    });
    expect(token.token).toMatch(/^ghs_fake/);
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const minted = github.tokens[0];
    expect(minted.repositoryIds).toEqual([repositoryId]);
    expect(minted.permissions).toEqual({ contents: 'read' });
    const mint = github.requestsTo('POST', /access_tokens$/)[0];
    expect(mint.auth).toBe('jwt');
  });

  it('reuses a token for the same scope and mints new ones for others', async () => {
    const read = {
      installationId,
      repositoryIds: [repositoryId],
      permissions: { contents: 'read' as const },
    };
    const first = await github.installationTokens.get(read);
    const again = await github.installationTokens.get({ ...read });
    const write = await github.installationTokens.get({
      ...read,
      permissions: { contents: 'write' },
    });
    expect(again.token).toBe(first.token);
    expect(write.token).not.toBe(first.token);
    const fresh = await github.installationTokens.get({ ...read, fresh: true });
    expect(fresh.token).not.toBe(first.token);
    expect(github.tokens).toHaveLength(3);
  });

  it('shares one mint between concurrent requests', async () => {
    const request = {
      installationId,
      repositoryIds: [repositoryId],
      permissions: { contents: 'read' as const },
    };
    const [a, b] = await Promise.all([
      github.installationTokens.get(request),
      github.installationTokens.get(request),
    ]);
    expect(a.token).toBe(b.token);
    expect(github.tokens).toHaveLength(1);
  });

  it('mints a new token after the reuse window', async () => {
    let now = Date.now();
    const tokens = new InstallationTokens(
      github.credentials,
      github.http,
      () => now,
    );
    const request = {
      installationId,
      repositoryIds: [repositoryId],
      permissions: { contents: 'read' as const },
    };
    const first = await tokens.get(request);
    now += 11 * 60_000;
    expect((await tokens.get(request)).token).not.toBe(first.token);
  });

  it('revokes tokens and forgets them', async () => {
    const request = {
      installationId,
      repositoryIds: [repositoryId],
      permissions: { contents: 'write' as const },
    };
    const token = await github.installationTokens.get(request);
    await github.installationTokens.revoke(token.token);
    expect(github.tokens[0].revoked).toBe(true);
    expect((await github.installationTokens.get(request)).token).not.toBe(
      token.token,
    );
  });

  it('fails for repositories outside the installation', async () => {
    await expect(
      github.installationTokens.get({
        installationId,
        repositoryIds: [999_999],
        permissions: { contents: 'read' },
      }),
    ).rejects.toThrow('not accessible');
  });
});
