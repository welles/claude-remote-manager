import { WebSocket } from 'ws';
import { SESSIONS_WS_PATH } from '../sessions/sessions.gateway';
import {
  postJson,
  rawRequest,
  startTestApp,
  type TestApp,
} from '../testing/test-app';
import { Authenticator } from './authenticator';
import { FakeAccess } from './testing/fake-access';

const SESSION_UID = 4321;

describe('authentication', () => {
  let app: TestApp;
  let access: FakeAccess;
  /** User ID of the peer of loopback connections, as the kernel reports. */
  let peerUid: number | null;

  beforeEach(async () => {
    access = new FakeAccess();
    peerUid = null;
    const auth = { mode: 'cloudflare-access' as const, access: access.config };
    const isolation = {
      mode: 'separate-users' as const,
      sessionUser: {
        name: 'claude',
        uid: SESSION_UID,
        gid: SESSION_UID,
        home: '/home/claude',
      },
    };
    app = await startTestApp(
      { auth },
      {
        configure: (builder) =>
          builder
            .overrideProvider(Authenticator)
            .useValue(
              new Authenticator(
                auth,
                isolation,
                access.verifier(),
                () => peerUid,
              ),
            ),
      },
    );
  });
  afterEach(() => app.close());

  const get = (path: string, headers: Record<string, string> = {}) =>
    rawRequest(app.port, 'GET', path, headers);

  it('requires a valid Access token and says why it refuses', async () => {
    const missing = await get('/api/sessions');
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('CloudflareAccess');
    expect(missing.json()).toEqual({
      statusCode: 401,
      reason: 'access_token_missing',
      message: 'Sign in through Cloudflare Access',
    });
    const now = Math.floor(Date.now() / 1000);
    const expired = await get('/api/sessions', {
      'cf-access-jwt-assertion': access.token({ exp: now - 3600 }),
    });
    expect(expired.json<{ reason: string }>().reason).toBe(
      'access_token_expired',
    );
    const foreign = await get('/api/sessions', {
      'cf-access-jwt-assertion': access.token({ aud: ['other-app'] }),
    });
    expect(foreign.status).toBe(401);

    expect(
      (
        await get('/api/sessions', {
          'cf-access-jwt-assertion': access.token(),
        })
      ).status,
    ).toBe(200);
    // The cookie is the fallback.
    expect(
      (
        await get('/api/sessions', {
          cookie: `a=b; CF_Authorization=${access.token()}`,
        })
      ).status,
    ).toBe(200);
    // Static files and unknown paths too.
    expect((await get('/index.html')).status).toBe(401);
  });

  it('refuses identities outside the allowlist with 403', async () => {
    access.config.allowedEmails = ['grace@example.com'];
    const response = await get('/api/sessions', {
      'cf-access-jwt-assertion': access.token(),
    });
    expect(response.status).toBe(403);
    expect(response.json<{ reason: string }>().reason).toBe(
      'access_email_not_allowed',
    );
  });

  it('exempts the health check and the credential endpoint only', async () => {
    expect((await get('/api/health')).status).toBe(200);
    const credentials = await postJson(app.port, '/api/git/credentials', {
      protocol: 'https',
      host: 'github.com',
      path: 'a/b',
    });
    // Reaches the endpoint, which wants a session token.
    expect(credentials.status).toBe(401);
    expect(credentials.json<{ message: string }>().message).toContain(
      'session token',
    );
    expect((await postJson(app.port, '/api/git/other', {})).status).toBe(401);
    expect((await rawRequest(app.port, 'POST', '/api/health')).status).toBe(
      401,
    );
    // The new routes are not exempt either.
    expect(
      (await postJson(app.port, '/api/sessions/x/permission-requests/y', {}))
        .status,
    ).toBe(401);
    expect((await get('/api/models')).status).toBe(401);
    expect((await get('/api/sessions/x/diff')).status).toBe(401);
  });

  it('refuses session processes, whatever token they bring', async () => {
    peerUid = SESSION_UID;
    const response = await get('/api/sessions', {
      'cf-access-jwt-assertion': access.token(),
    });
    expect(response.status).toBe(403);
    expect(response.json<{ reason: string }>().reason).toBe(
      'session_process_refused',
    );
    const push = await postJson(
      app.port,
      '/api/sessions/x/repositories/y/push',
      {},
      { 'cf-access-jwt-assertion': access.token() },
    );
    expect(push.status).toBe(403);
    // A session process can never answer its own approval requests, change
    // its mode or model, or look at what waits for approval.
    const token = { 'cf-access-jwt-assertion': access.token() };
    for (const [method, path] of [
      ['POST', '/api/sessions/x/permission-requests/y'],
      ['GET', '/api/sessions/x/permission-requests'],
      ['PATCH', '/api/sessions/x'],
      ['DELETE', '/api/sessions/x/queued-messages/y'],
      ['GET', '/api/models'],
      ['GET', '/api/limits'],
      // Images for messages.
      ['POST', '/api/attachments'],
      ['GET', '/api/attachments/x'],
      // What the session changed.
      ['GET', '/api/sessions/x/diff'],
      ['GET', '/api/sessions/x/diff/file?repositoryId=r&path=a'],
    ] as const) {
      const response =
        method === 'GET' || method === 'DELETE'
          ? await rawRequest(app.port, method, path, token)
          : await rawRequest(
              app.port,
              method,
              path,
              { ...token, 'content-type': 'application/json' },
              '{}',
            );
      expect([method, path, response.status]).toEqual([method, path, 403]);
      expect(response.json<{ reason: string }>().reason).toBe(
        'session_process_refused',
      );
    }
    // What sessions need stays reachable.
    expect((await get('/api/health')).status).toBe(200);
    expect(
      (
        await postJson(app.port, '/api/git/credentials', {
          protocol: 'https',
          host: 'github.com',
          path: 'a/b',
        })
      ).json<{ message: string }>().message,
    ).toContain('session token');
    // Other local users (e.g. the API's own) are not affected.
    peerUid = 1000;
    expect(
      (
        await get('/api/sessions', {
          'cf-access-jwt-assertion': access.token(),
        })
      ).status,
    ).toBe(200);
  });

  describe('WebSocket upgrades', () => {
    const connect = (headers: Record<string, string>) =>
      new Promise<{ opened: boolean; status?: number }>((resolve) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${app.port}${SESSIONS_WS_PATH}`,
          {
            headers,
          },
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

    it('need a valid token as well', async () => {
      expect(await connect({})).toEqual({ opened: false, status: 401 });
      expect(
        await connect({
          'cf-access-jwt-assertion': access.token({ aud: 'x' }),
        }),
      ).toEqual({ opened: false, status: 401 });
      expect(
        await connect({ 'cf-access-jwt-assertion': access.token() }),
      ).toEqual({
        opened: true,
      });
      expect(
        await connect({ cookie: `CF_Authorization=${access.token()}` }),
      ).toEqual({
        opened: true,
      });
      peerUid = SESSION_UID;
      expect(
        await connect({ 'cf-access-jwt-assertion': access.token() }),
      ).toEqual({
        opened: false,
        status: 403,
      });
    });
  });
});
