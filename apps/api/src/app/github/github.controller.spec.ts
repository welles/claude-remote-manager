import type {
  GitHubRepositoryListResponse,
  GitHubStatusDto,
} from '@claude-remote-manager/shared-types';
import { rawRequest, startTestApp, type TestApp } from '../testing/test-app';
import { GitHubAppCredentials } from './github-app-credentials';
import { GITHUB_FETCH } from './github-http';
import { FakeGitHub } from './testing/fake-github';

describe('GitHub REST API', () => {
  let app: TestApp | undefined;
  afterEach(() => app?.close());

  it('works without GitHub configuration and says so', async () => {
    app = await startTestApp();
    const status = await rawRequest(app.port, 'GET', '/api/github/status');
    expect(status.status).toBe(200);
    expect(status.json<GitHubStatusDto>()).toMatchObject({
      configured: false,
      problem: 'GITHUB_APP_ID is not set',
    });
    const list = await rawRequest(app.port, 'GET', '/api/github/repositories');
    expect(list.status).toBe(503);
    expect(list.json<{ message: string }>().message).toContain(
      'not configured',
    );
  });

  it('shows the app, its installations and their repositories', async () => {
    const github = new FakeGitHub();
    const user = github.addInstallation('alice');
    github.addRepository(user, 'app');
    github.addRepository(
      github.addInstallation('acme', 'Organization'),
      'tool',
    );
    app = await startTestApp(
      {},
      {
        configure: (builder) =>
          builder
            .overrideProvider(GITHUB_FETCH)
            .useValue(github.fetch)
            .overrideProvider(GitHubAppCredentials)
            .useValue(github.credentials),
      },
    );
    const status = (
      await rawRequest(app.port, 'GET', '/api/github/status')
    ).json<GitHubStatusDto>();
    expect(status).toMatchObject({
      configured: true,
      appSlug: 'test-app',
      installUrl: 'https://github.com/apps/test-app/installations/new',
      installations: [
        { account: 'alice', accountType: 'User', repositoryCount: 1 },
        { account: 'acme', accountType: 'Organization', repositoryCount: 1 },
      ],
    });
    const list = (
      await rawRequest(
        app.port,
        'GET',
        '/api/github/repositories?query=tool&perPage=5',
      )
    ).json<GitHubRepositoryListResponse>();
    expect(list).toMatchObject({ total: 1, perPage: 5 });
    expect(list.repositories[0].fullName).toBe('acme/tool');
    expect(
      (await rawRequest(app.port, 'GET', '/api/github/repositories?page=0'))
        .status,
    ).toBe(400);
  });
});
