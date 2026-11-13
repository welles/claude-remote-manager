import type {
  GitHubReferenceDetail,
  GitHubReferenceSearchResponse,
  MessageContextResponse,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { GitHubAppCredentials } from '../github/github-app-credentials';
import { GITHUB_FETCH } from '../github/github-http';
import { FakeGitHub } from '../github/testing/fake-github';
import { waitFor } from '../sessions/testing/fake-agent';
import {
  postJson,
  rawRequest,
  startTestApp,
  type TestApp,
} from '../testing/test-app';

describe('GitHub references REST API', () => {
  let app: TestApp | undefined;
  afterEach(() => app?.close());

  const start = async (github: FakeGitHub) =>
    startTestApp(
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

  it('suggests, previews and attaches issues; shows what Claude got', async () => {
    const github = new FakeGitHub();
    const repository = github.addRepository(
      github.addInstallation('acme'),
      'app',
    );
    github.addIssue(repository, { title: 'Login fails', body: 'Details' });
    app = await start(github);

    const search = await rawRequest(
      app.port,
      'GET',
      '/api/github/references?query=login&repositories=acme/app',
    );
    expect(search.status).toBe(200);
    expect(search.json<GitHubReferenceSearchResponse>()).toEqual({
      results: [expect.objectContaining({ number: 1, title: 'Login fails' })],
      errors: [],
    });
    expect(
      (
        await rawRequest(
          app.port,
          'GET',
          '/api/github/references?repositories=evil.com/x',
        )
      ).status,
    ).toBe(400);

    const detail = await rawRequest(
      app.port,
      'GET',
      '/api/github/references/acme/app/1',
    );
    expect(detail.json<GitHubReferenceDetail>()).toMatchObject({
      title: 'Login fails',
      body: 'Details',
    });
    expect(
      (await rawRequest(app.port, 'GET', '/api/github/references/acme/app/x'))
        .status,
    ).toBe(400);
    expect(
      (await rawRequest(app.port, 'GET', '/api/github/references/acme/nope/1'))
        .status,
    ).toBe(404);

    const created = await postJson(app.port, '/api/sessions', {
      prompt: 'Fix #1',
      scratch: true,
      references: [{ token: '#1', repository: 'acme/app', number: 1 }],
    });
    expect(created.status).toBe(201);
    const session = created.json<SessionDto>();
    const runner = app.runner;
    await waitFor(() => runner.runs.length > 0);
    const messageId = runner.last.sent[0].id;
    const context = await rawRequest(
      app.port,
      'GET',
      `/api/sessions/${session.id}/messages/${messageId}/context`,
    );
    expect(context.status).toBe(200);
    expect(context.json<MessageContextResponse>()).toMatchObject({
      messageId,
      context: runner.last.sent[0].context?.text,
      references: [{ token: '#1', status: 'resolved' }],
    });
  });

  it('says why when GitHub is not configured', async () => {
    app = await startTestApp();
    const search = await rawRequest(
      app.port,
      'GET',
      '/api/github/references?query=1&repositories=acme/app',
    );
    expect(search.json<GitHubReferenceSearchResponse>()).toEqual({
      results: [],
      errors: [
        'acme/app: The GitHub App is not configured: GITHUB_APP_ID is not set',
      ],
    });
  });
});
