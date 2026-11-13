import { WorkspaceHarness } from './testing/workspace-harness';

describe('sessions when GitHub is not reachable', () => {
  let harness: WorkspaceHarness;

  beforeEach(async () => {
    harness = new WorkspaceHarness();
    await harness.start();
  });
  afterEach(() => harness.close());

  it('start from the mirror fetched before, with a warning', async () => {
    const repository = await harness.addRepository('alice', 'app');
    const installation = harness.github.addInstallation('alice');
    const remote = harness.github.addRepository(installation, 'app');
    harness.repositoryRecords.update(repository.id, {
      githubRepositoryId: remote.id,
      githubInstallationId: installation.id,
    });
    // Cloned while GitHub was there (with a read token for the mirror).
    await harness.repositories.update(repository.id);
    expect(harness.github.tokens.at(-1)?.permissions).toEqual({
      contents: 'read',
    });

    harness.github.intercept = () => {
      throw new TypeError('fetch failed', {
        cause: new Error('getaddrinfo EAI_AGAIN api.github.com'),
      });
    };
    // Tokens are cached briefly; a new installation-token request is needed.
    harness.github.installationTokens.invalidate(installation.id);
    const session = await harness.service.create({
      prompt: 'Work',
      repositories: [{ repositoryId: repository.id }],
    });
    await harness.prepared(session.id);

    expect(harness.service.get(session.id).status).toBe('running');
    const notices = harness.eventsOfType(session.id, 'notice');
    expect(notices.map((notice) => notice.text).join(' ')).toContain(
      'could not be fetched; the session starts from the state fetched',
    );
    const failed = harness
      .eventsOfType(session.id, 'prepare.progress')
      .find((event) => event.step === 'fetch' && event.state === 'failed');
    expect(failed?.message).toContain('GitHub is not reachable');
    expect(
      harness.repositoryRecords.require(repository.id).lastError,
    ).toContain('EAI_AGAIN');
  });
});
