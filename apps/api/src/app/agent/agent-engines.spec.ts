import type {
  EngineListResponse,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { waitFor } from '../sessions/testing/fake-agent';
import {
  postJson,
  rawRequest,
  startTestApp,
  type TestApp,
} from '../testing/test-app';

describe('agent engines', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp();
  });
  afterAll(() => app.close());

  it('lists the engines with what they offer', async () => {
    const response = (
      await rawRequest(app.port, 'GET', '/api/engines')
    ).json<EngineListResponse>();
    expect(response.engines).toEqual([
      expect.objectContaining({
        id: 'claude-code',
        label: 'Claude Code',
        provider: 'claude',
        capabilities: expect.objectContaining({
          planMode: true,
          permissionModes: expect.arrayContaining(['default', 'auto']),
        }),
      }),
    ]);
  });

  it('runs sessions with an engine, the default one without a choice', async () => {
    const session = (
      await postJson(app.port, '/api/sessions', { prompt: 'Hi', scratch: true })
    ).json<SessionDto>();
    expect(session.engine).toBe('claude-code');
    await waitFor(() => app.runner.runs.length === 1);
    const unknown = await postJson(app.port, '/api/sessions', {
      prompt: 'Hi',
      scratch: true,
      engine: 'something-else',
    });
    expect(unknown.status).toBe(400);
  });
});
