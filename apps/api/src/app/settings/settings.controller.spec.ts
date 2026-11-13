import {
  postJson,
  rawRequest,
  startTestApp,
  type TestApp,
} from '../testing/test-app';

describe('settings REST API', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await startTestApp({}, { identity: false });
  });
  afterEach(() => app.close());

  const put = (body: unknown) =>
    rawRequest(
      app.port,
      'PUT',
      '/api/settings',
      { 'content-type': 'application/json' },
      JSON.stringify(body),
    );

  it('reads and changes the settings', async () => {
    expect((await rawRequest(app.port, 'GET', '/api/settings')).json()).toEqual(
      {
        gitAuthorName: null,
        gitAuthorEmail: null,
      },
    );
    const response = await put({
      gitAuthorName: 'Ada',
      gitAuthorEmail: 'ada@example.com',
    });
    expect(response.status).toBe(200);
    expect((await rawRequest(app.port, 'GET', '/api/settings')).json()).toEqual(
      {
        gitAuthorName: 'Ada',
        gitAuthorEmail: 'ada@example.com',
      },
    );
    expect((await put({ gitAuthorEmail: 'nope' })).status).toBe(400);
  });

  it('refuses sessions with repositories until the identity is set', async () => {
    const response = await postJson(app.port, '/api/repositories', {
      projectName: 'new-app',
    });
    expect(response.status).toBe(409);
    expect(response.json<{ message: string }>().message).toContain(
      'Settings page',
    );
  });
});
