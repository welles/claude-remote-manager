import {
  postJson,
  rawRequest,
  startTestApp,
  type TestApp,
} from '../testing/test-app';

describe('settings REST API', () => {
  let app: TestApp | undefined;

  afterEach(() => app?.close());

  it('shows the commit identity of the environment, read-only', async () => {
    app = await startTestApp({
      gitIdentity: { name: 'Ada', email: 'ada@example.com' },
    });
    expect((await rawRequest(app.port, 'GET', '/api/settings')).json()).toEqual(
      {
        gitAuthorName: 'Ada',
        gitAuthorEmail: 'ada@example.com',
      },
    );
    const put = await rawRequest(
      app.port,
      'PUT',
      '/api/settings',
      { 'content-type': 'application/json' },
      JSON.stringify({ gitAuthorName: 'Eve', gitAuthorEmail: 'eve@x.y' }),
    );
    expect(put.status).toBe(404);
  });

  it('refuses sessions with repositories without an identity', async () => {
    app = await startTestApp({}, { identity: false });
    expect((await rawRequest(app.port, 'GET', '/api/settings')).json()).toEqual(
      {
        gitAuthorName: null,
        gitAuthorEmail: null,
      },
    );
    const response = await postJson(app.port, '/api/repositories', {
      projectName: 'new-app',
    });
    expect(response.status).toBe(409);
    expect(response.json<{ message: string }>().message).toContain(
      'CRM_GIT_AUTHOR_EMAIL',
    );
  });
});
