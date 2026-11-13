import { rawRequest, startTestApp, type TestApp } from '../testing/test-app';

describe('SessionDiffController', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp();
  });
  afterAll(() => app.close());

  it('answers for known sessions only and checks its parameters', async () => {
    const get = (path: string) => rawRequest(app.port, 'GET', path);
    expect((await get('/api/sessions/unknown/diff')).status).toBe(404);
    expect((await get('/api/sessions/unknown/diff/file')).status).toBe(400);
    expect(
      (await get('/api/sessions/unknown/diff/file?repositoryId=r&path=a'))
        .status,
    ).toBe(404);
  });
});
