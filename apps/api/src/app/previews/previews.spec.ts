import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  PreviewDto,
  SessionDto,
  SessionEvent,
} from '@claude-remote-manager/shared-types';
import { AccessJwtVerifier } from '../auth/access-jwt';
import { Authenticator } from '../auth/authenticator';
import { FakeAccess } from '../auth/testing/fake-access';
import { appCsp } from '../configure-app';
import type { PreviewConfig } from '../config/app-config';
import { SessionRepository } from '../sessions/session.repository';
import { SessionsService } from '../sessions/sessions.service';
import { newSessionRecord } from '../sessions/testing/records';
import { resultMessage, waitFor } from '../sessions/testing/fake-agent';
import {
  postJson,
  rawRequest,
  startTestApp,
  type TestApp,
} from '../testing/test-app';
import { PreviewAccess } from './preview-access';
import { PROXY_TIMEOUTS } from './preview-proxy';
import { PreviewsService } from './previews.service';

const PREVIEWS: PreviewConfig = {
  scheme: 'http',
  domain: 'preview.localhost',
  port: null,
  accessAudiences: [],
};

/** A dev server on a random loopback port that records what it got. */
class DevServer {
  readonly server: Server;
  readonly requests: { url: string; headers: IncomingHttpHeaders }[] = [];
  readonly sockets: WebSocket[] = [];
  handler: (request: IncomingMessage, response: ServerResponse) => void = (
    request,
    response,
  ) => {
    response.setHeader('content-type', 'text/plain');
    response.end(`dev server: ${request.method} ${request.url}`);
  };
  port = 0;

  constructor() {
    this.server = createServer((request, response) => {
      this.requests.push({ url: request.url ?? '', headers: request.headers });
      this.handler(request, response);
    });
    const wss = new WebSocketServer({ server: this.server });
    wss.on('connection', (socket, request) => {
      this.requests.push({
        url: `ws:${request.url ?? ''}`,
        headers: request.headers,
      });
      this.sockets.push(socket);
      socket.on('message', (data) => socket.send(`echo ${String(data)}`));
    });
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<number> {
    await new Promise<void>((resolve) =>
      this.server.listen(port, host, resolve),
    );
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.terminate();
    }
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  last(): { url: string; headers: IncomingHttpHeaders } {
    const last = this.requests.at(-1);
    if (!last) {
      throw new Error('no request');
    }
    return last;
  }
}

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function hostOf(preview: PreviewDto): string {
  return new URL(preview.url).hostname;
}

describe('previews of dev servers', () => {
  let app: TestApp;
  let previews: PreviewsService;
  let dev: DevServer;
  const timeouts = { ...PROXY_TIMEOUTS };

  beforeEach(async () => {
    app = await startTestApp({ previews: PREVIEWS });
    previews = app.app.get(PreviewsService);
    dev = new DevServer();
    await dev.listen();
    app.app
      .get(SessionRepository, { strict: false })
      .create(
        newSessionRecord({ id: 's-1', slug: 'demo-abc123', status: 'waiting' }),
      );
    app.app.get(SessionRepository, { strict: false }).create(
      newSessionRecord({
        id: 's-2',
        slug: 'other-xyz789',
        status: 'waiting',
      }),
    );
  });

  afterEach(async () => {
    Object.assign(PROXY_TIMEOUTS, timeouts);
    await dev.close();
    await app.close();
  });

  /** A request to a host name of this server. */
  const get = (
    host: string,
    path = '/',
    headers: Record<string, string> = {},
    method = 'GET',
    body?: string,
  ) =>
    rawRequest(
      app.port,
      method,
      path,
      { host: `${host}:${app.port}`, ...headers },
      body,
    );

  const expose = (port = dev.port, session = 's-1', name = 'Web app') =>
    previews.expose(session, port, name, null).preview;

  it('gives every preview a host name of its own and forwards to it', async () => {
    const preview = expose();
    expect(preview).toMatchObject({
      sessionId: 's-1',
      port: dev.port,
      name: 'Web app',
      url: `http://demo-abc123-${dev.port}.preview.localhost`,
      state: 'running',
      problem: null,
    });
    const response = await get(hostOf(preview), '/src/main.ts?t=1');
    expect(response.status).toBe(200);
    expect(response.body).toBe('dev server: GET /src/main.ts?t=1');
    // The session lists it.
    expect(app.app.get(SessionsService).get('s-1').previews).toEqual([preview]);
  });

  it('shows the dev server the request as if it ran on localhost', async () => {
    const preview = expose();
    const host = hostOf(preview);
    await get(host, '/page', {
      origin: `http://${host}:${app.port}`,
      referer: `http://${host}:${app.port}/start?x=1`,
      cookie: `theme=dark; CF_Authorization=secret-token; CF_AppSession=s; __cf_bm=b; sid=1`,
      'cf-access-jwt-assertion': 'secret-token',
      'cf-access-authenticated-user-email': 'ada@example.com',
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '203.0.113.7',
      'x-forwarded-host': 'evil.example',
      forwarded: 'for=203.0.113.7',
      'x-custom': 'kept',
    });
    const seen = dev.last().headers;
    expect(seen['host']).toBe(`localhost:${dev.port}`);
    expect(seen['origin']).toBe(`http://localhost:${dev.port}`);
    expect(seen['referer']).toBe(`http://localhost:${dev.port}/start?x=1`);
    expect(seen['cookie']).toBe('theme=dark; sid=1');
    expect(seen['x-custom']).toBe('kept');
    for (const name of Object.keys(seen)) {
      expect(name).not.toMatch(/^(cf-|x-forwarded|forwarded)/);
    }
    expect(JSON.stringify(seen)).not.toContain('secret-token');

    // The app's page embedding it is not the dev server's business, and a
    // foreign origin stays visible to the dev server's own checks.
    await get(host, '/', {
      referer: 'http://localhost:4200/sessions/s-1',
      origin: 'https://evil.example',
      cookie: 'CF_Authorization=secret-token',
    });
    expect(dev.last().headers['referer']).toBeUndefined();
    expect(dev.last().headers['origin']).toBe('https://evil.example');
    expect(dev.last().headers['cookie']).toBeUndefined();
  });

  it('rewrites redirects to the dev server and keeps its cookies on the preview host', async () => {
    const preview = expose();
    dev.handler = (_request, response) => {
      response.setHeader(
        'location',
        `http://localhost:${dev.port}/login?next=/`,
      );
      response.setHeader('set-cookie', [
        'sid=1; Domain=localhost; Path=/; HttpOnly',
        'theme=dark; domain=.preview.localhost',
      ]);
      response.statusCode = 302;
      response.end();
    };
    const response = await get(hostOf(preview));
    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe(
      `http://${hostOf(preview)}:${app.port}/login?next=/`,
    );
    expect(response.headers['set-cookie']).toEqual([
      'sid=1; Path=/; HttpOnly',
      'theme=dark',
    ]);
  });

  it('streams bodies both ways without buffering', async () => {
    const preview = expose();
    let release: () => void = () => undefined;
    dev.handler = (request, response) => {
      if (request.method === 'POST') {
        // Echo the upload as it arrives.
        request.pipe(response);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('first ');
      release = () => response.end('second');
    };
    const firstChunk = await new Promise<string>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: app.port,
          path: '/events',
          headers: { host: `${hostOf(preview)}:${app.port}` },
        },
        (response) => {
          response.setEncoding('utf8');
          response.once('data', (chunk: string) => resolve(chunk));
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(firstChunk).toBe('first ');
    release();

    const upload = 'x'.repeat(3 * 1024 * 1024);
    const echoed = await get(hostOf(preview), '/upload', {}, 'POST', upload);
    expect(echoed.body.length).toBe(upload.length);
  });

  it('streams a large download completely', async () => {
    const preview = expose();
    const total = 64 * 1024 * 1024;
    dev.handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 7);
      let sent = 0;
      const pump = () => {
        while (sent < total) {
          sent += chunk.length;
          if (!response.write(chunk)) {
            response.once('drain', pump);
            return;
          }
        }
        response.end();
      };
      pump();
    };
    const received = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: app.port,
          path: '/big.bin',
          headers: { host: `${hostOf(preview)}:${app.port}` },
        },
        (response) => {
          let bytes = 0;
          response.on('data', (chunk: Buffer) => (bytes += chunk.length));
          response.on('end', () => resolve(bytes));
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(received).toBe(total);
  });

  it('forwards WebSockets (hot reload) and refuses them from other sites', async () => {
    const preview = expose();
    const host = `${hostOf(preview)}:${app.port}`;
    const socket = new WebSocket(
      `ws://127.0.0.1:${app.port}/@vite/ws?token=t`,
      {
        headers: { host, origin: `http://${host}` },
      },
    );
    const reply = await new Promise<string>((resolve, reject) => {
      socket.on('open', () => socket.send('ping'));
      socket.on('message', (data) => resolve(String(data)));
      socket.on('error', reject);
    });
    expect(reply).toBe('echo ping');
    expect(dev.last().url).toBe('ws:/@vite/ws?token=t');
    expect(dev.last().headers['host']).toBe(`localhost:${dev.port}`);
    expect(dev.last().headers['origin']).toBe(`http://localhost:${dev.port}`);
    socket.close();

    const status = (origin: string) =>
      new Promise<number>((resolve) => {
        const other = new WebSocket(`ws://127.0.0.1:${app.port}/`, {
          headers: { host, origin },
        });
        other.on('open', () => {
          other.close();
          resolve(101);
        });
        other.on('unexpected-response', (_request, response) =>
          resolve(response.statusCode ?? 0),
        );
        other.on('error', () => resolve(0));
      });
    expect(await status('https://evil.example')).toBe(403);
    expect(await status(`http://localhost:${app.port}`)).toBe(403);
    // Another preview (a front end talking to its back end) may.
    expect(
      await status(`http://other-1-5173.preview.localhost:${app.port}`),
    ).toBe(101);
  });

  it('serves nothing of the app on preview hosts', async () => {
    const preview = expose();
    const host = hostOf(preview);
    for (const path of ['/api/health', '/api/sessions', '/', '/sw.js']) {
      const response = await get(host, path);
      expect(response.body).toBe(`dev server: GET ${path}`);
      expect(response.headers['content-security-policy']).toBeUndefined();
    }
    // Not even the app's WebSocket.
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/api/ws`, {
      headers: { host: `${host}:${app.port}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    expect(dev.last().url).toBe('ws:/api/ws');
    socket.close();

    // Unknown names in the domain get the app's plain page, not the app.
    for (const name of [
      'preview.localhost',
      'nobody-1234.preview.localhost',
      `a.${host}`,
    ]) {
      const response = await get(name, '/api/sessions', {
        accept: 'text/html',
      });
      expect(response.status).toBe(404);
      expect(response.body).toContain('No preview here');
      expect(response.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
    }
    // The app's own host serves no preview, and refuses preview origins.
    expect((await rawRequest(app.port, 'GET', '/api/health')).status).toBe(200);
    expect(
      (
        await rawRequest(app.port, 'GET', '/api/sessions', {
          origin: `http://${host}:${app.port}`,
        })
      ).status,
    ).toBe(403);
    const appSocket = new WebSocket(`ws://127.0.0.1:${app.port}/api/ws`, {
      headers: { origin: `http://${host}:${app.port}` },
    });
    const appStatus = await new Promise<number>((resolve) => {
      appSocket.on('open', () => resolve(101));
      appSocket.on('unexpected-response', (_request, response) =>
        resolve(response.statusCode ?? 0),
      );
      appSocket.on('error', () => resolve(0));
    });
    expect(appStatus).toBe(403);
  });

  it('answers with a page while the dev server is down, and forwards again once it is back', async () => {
    const preview = expose();
    const host = hostOf(preview);
    const port = dev.port;
    await dev.close();
    await waitFor(
      () =>
        app.app.get(SessionsService).get('s-1').previews[0]?.state ===
        'unreachable',
      5000,
    );
    const down = await get(host, '/', { accept: 'text/html' });
    expect(down.status).toBe(502);
    expect(down.body).toContain('The dev server is not running');
    expect(down.body).toContain('http-equiv="refresh"');
    const text = await get(host, '/x.js');
    expect(text.status).toBe(502);
    expect(text.headers['retry-after']).toBe('5');

    dev = new DevServer();
    await dev.listen(port);
    const up = await get(host, '/');
    expect(up.status).toBe(200);
    expect(up.body).toBe('dev server: GET /');
  });

  it('answers with a page when the dev server is too slow', async () => {
    PROXY_TIMEOUTS.responseMs = 200;
    const preview = expose();
    dev.handler = () => undefined;
    const response = await get(hostOf(preview), '/', { accept: 'text/html' });
    expect(response.status).toBe(504);
    expect(response.body).toContain('The dev server is too slow');
  });

  it('exposes a port nothing listens on yet and waits for it', async () => {
    const port = await freePort();
    const preview = expose(port);
    expect(preview.state).toBe('unreachable');
    expect(preview.problem).toBe(`Nothing listens on port ${port}`);
    expect((await get(hostOf(preview))).status).toBe(502);
  });

  it('refuses the API’s own port, ports of other sessions and other addresses', async () => {
    expect(() => expose(app.port)).toThrow("session manager's own port");
    expose(dev.port, 's-1');
    expect(() => expose(dev.port, 's-2')).toThrow('exposed by another session');
    // Exposing again renames.
    expect(previews.expose('s-1', dev.port, 'Renamed', null)).toMatchObject({
      created: false,
      preview: { name: 'Renamed' },
    });
    expect(() => expose(0)).toThrow('1 to 65535');
    expect(() => previews.expose('s-1', dev.port, ' ', null)).toThrow(
      'The name',
    );
  });

  it('stops forwarding when stopped, also open WebSockets', async () => {
    const preview = expose();
    const host = `${hostOf(preview)}:${app.port}`;
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/`, {
      headers: { host },
    });
    await new Promise((resolve) => socket.on('open', resolve));
    const closed = new Promise((resolve) => socket.on('close', resolve));

    const response = await postJson(
      app.port,
      `/api/sessions/s-1/previews/${preview.id}/stop`,
      {},
    );
    expect(response.status).toBe(200);
    expect(response.json<PreviewDto>()).toMatchObject({
      state: 'stopped',
      stoppedBy: 'user',
    });
    await closed;
    const after = await get(hostOf(preview), '/', { accept: 'text/html' });
    expect(after.status).toBe(410);
    expect(after.body).toContain('This preview was stopped');
    expect(app.app.get(SessionsService).get('s-1').previews).toEqual([]);
    // The dev server keeps running.
    expect(dev.server.listening).toBe(true);
    // Another session's preview cannot be stopped through this one.
    const other = expose(dev.port, 's-1');
    expect(
      (
        await postJson(
          app.port,
          `/api/sessions/s-2/previews/${other.id}/stop`,
          {},
        )
      ).status,
    ).toBe(404);
  });

  it('records exposing and stopping in the session’s history, and stops previews when the session ends', async () => {
    const sessions = app.app.get(SessionsService);
    const preview = expose();
    previews.stopPort('s-1', dev.port, 'tool-2');
    expose(dev.port);
    await sessions.end('s-1');
    expect(sessions.get('s-1').previews).toEqual([]);
    const snapshot = await sessions.subscribe('s-1');
    const events = snapshot.events.filter((event: SessionEvent) =>
      event.type.startsWith('preview.'),
    );
    expect(events.map((event) => event.type)).toEqual([
      'preview.exposed',
      'preview.stopped',
      'preview.exposed',
      'preview.stopped',
    ]);
    expect(events[0]).toMatchObject({ preview: { id: preview.id } });
    expect(events[1]).toMatchObject({ by: 'claude', toolUseId: 'tool-2' });
    expect(events[3]).toMatchObject({ by: 'session_end' });
    sessions.unsubscribe('s-1');
    // Single user: only processes the API started are stopped; this dev
    // server runs in the API's (the test's) own process.
    expect(dev.server.listening).toBe(true);
  });

  it('stops dev servers the API started when the session ends', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [
      '-e',
      `require('http').createServer((q, r) => r.end('child')).listen(${port}, '127.0.0.1')`,
    ]);
    const exited = new Promise((resolve) => child.on('exit', resolve));
    try {
      await waitFor(() => expose(port).state === 'running', 5000);
      await app.app.get(SessionsService).end('s-1');
      await exited;
      expect(child.exitCode ?? child.signalCode).toBe('SIGTERM');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('gives Claude expose_port and stop_preview without approval', async () => {
    const created = await postJson(app.port, '/api/sessions', {
      prompt: 'Start the dev server',
      newProject: { name: 'web' },
    });
    const session = created.json<SessionDto>();
    await waitFor(() => app.runner.runs.length === 1);
    const options = app.runner.last.options;
    expect(options.allowedTools).toEqual(
      expect.arrayContaining([
        'mcp__crm__expose_port',
        'mcp__crm__stop_preview',
      ]),
    );
    const tool = (name: string) => {
      const found = options.tools?.find((each) => each.name === name);
      if (!found) {
        throw new Error(`no tool ${name}`);
      }
      return found;
    };
    const result = await tool('expose_port').handler(
      { port: dev.port, name: 'Web app' },
      { toolUseId: 'toolu_1' },
    );
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain(
      `http://${session.slug}-${dev.port}.preview.localhost`,
    );
    const refused = await tool('expose_port').handler(
      { port: app.port, name: 'API' },
      { toolUseId: 'toolu_2' },
    );
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain("session manager's own port");
    const stopped = await tool('stop_preview').handler(
      { port: dev.port },
      { toolUseId: 'toolu_3' },
    );
    expect(stopped.text).toContain('Stopped the preview "Web app"');
  });

  it('lets the app frame preview hosts and nothing else', async () => {
    const page = await rawRequest(app.port, 'GET', '/sessions/x');
    expect(page.headers['content-security-policy']).toBe(appCsp(PREVIEWS));
    expect(appCsp(PREVIEWS)).toContain(
      "frame-src 'self' http://*.preview.localhost;",
    );
    expect(
      appCsp({ ...PREVIEWS, scheme: 'https', domain: 'preview.example.com' }),
    ).toContain("frame-src 'self' https://*.preview.example.com;");
    expect(appCsp({ ...PREVIEWS, port: 3000 })).toContain(
      'http://*.preview.localhost:3000;',
    );
  });
});

describe('sessions with previews', () => {
  let app: TestApp;
  let dev: DevServer;

  beforeEach(async () => {
    app = await startTestApp({ previews: PREVIEWS, sessionIdleTimeoutMs: 150 });
    dev = new DevServer();
    await dev.listen();
  });
  afterEach(async () => {
    await dev.close();
    await app.close();
  });

  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it('do not go idle; the idle clock starts when the last preview stops', async () => {
    const created = await postJson(app.port, '/api/sessions', {
      prompt: 'Start the dev server',
      newProject: { name: 'web' },
    });
    const session = created.json<SessionDto>();
    await waitFor(() => app.runner.runs.length === 1);
    const run = app.runner.last;
    const previews = app.app.get(PreviewsService);
    const sessions = app.app.get(SessionsService);
    const preview = previews.expose(session.id, dev.port, 'Web', 't1').preview;
    run.emit(resultMessage(1, 0));
    await waitFor(() => sessions.get(session.id).status === 'waiting');

    await pause(400);
    expect(run.closed).toBe(false);

    previews.stop(session.id, preview.id);
    await pause(60);
    // The clock started at the stop, not at the end of the turn.
    expect(run.closed).toBe(false);
    await waitFor(() => run.closed, 2000);
  });

  it('go idle as usual without previews', async () => {
    const created = await postJson(app.port, '/api/sessions', {
      prompt: 'Hi',
      newProject: { name: 'plain' },
    });
    const session = created.json<SessionDto>();
    await waitFor(() => app.runner.runs.length === 1);
    app.runner.last.emit(resultMessage(1, 0));
    await waitFor(
      () => app.app.get(SessionsService).get(session.id).status === 'waiting',
    );
    await waitFor(() => app.runner.last.closed, 2000);
  });
});

describe('previews behind Cloudflare Access', () => {
  const SESSION_UID = 4321;
  const PREVIEW_AUD = 'preview-aud-5678';
  let app: TestApp;
  let access: FakeAccess;
  let dev: DevServer;
  let peerUid: number | null;
  let host: string;

  beforeEach(async () => {
    access = new FakeAccess();
    peerUid = null;
    const auth = { mode: 'cloudflare-access' as const, access: access.config };
    const previewsConfig = { ...PREVIEWS, accessAudiences: [PREVIEW_AUD] };
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
      { auth, previews: previewsConfig },
      {
        configure: (builder) =>
          builder
            .overrideProvider(Authenticator)
            .useValue(
              new Authenticator(auth, isolation, access.verifier(), () =>
                peerUid === null ? null : { uid: peerUid, inode: 1 },
              ),
            )
            .overrideProvider(PreviewAccess)
            .useValue(
              new PreviewAccess(
                auth,
                previewsConfig,
                isolation,
                new AccessJwtVerifier(
                  { ...access.config, audiences: [PREVIEW_AUD] },
                  access.jwks,
                ),
                () => (peerUid === null ? null : { uid: peerUid, inode: 1 }),
              ),
            ),
      },
    );
    dev = new DevServer();
    await dev.listen();
    app.app
      .get(SessionRepository, { strict: false })
      .create(
        newSessionRecord({ id: 's-1', slug: 'demo-abc123', status: 'waiting' }),
      );
    // Single user in the API process: the dev server is the test's own.
    const preview = app.app
      .get(PreviewsService)
      .expose('s-1', dev.port, 'Web app', null).preview;
    host = `${new URL(preview.url).hostname}:${app.port}`;
  });

  afterEach(async () => {
    await dev.close();
    await app.close();
  });

  it('needs a token of the preview application, which the API refuses', async () => {
    const missing = await rawRequest(app.port, 'GET', '/', { host });
    expect(missing.status).toBe(401);
    expect(dev.requests).toHaveLength(0);
    // The app's own token is not a preview token.
    const appToken = await rawRequest(app.port, 'GET', '/', {
      host,
      'cf-access-jwt-assertion': access.token(),
    });
    expect(appToken.status).toBe(401);
    expect(dev.requests).toHaveLength(0);

    const token = access.token({ aud: [PREVIEW_AUD] });
    const ok = await rawRequest(app.port, 'GET', '/', {
      host,
      'cf-access-jwt-assertion': token,
      cookie: `CF_Authorization=${token}; a=b`,
    });
    expect(ok.status).toBe(200);
    // Neither header nor cookie reach the dev server.
    expect(JSON.stringify(dev.last().headers)).not.toContain(token);
    expect(dev.last().headers['cookie']).toBe('a=b');

    // The preview token is worthless against the API.
    const api = await rawRequest(app.port, 'GET', '/api/sessions', {
      'cf-access-jwt-assertion': token,
    });
    expect(api.status).toBe(401);
  });

  it('refuses WebSocket upgrades without a token', async () => {
    const status = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${app.port}/`, {
        headers: { host },
      });
      socket.on('open', () => resolve(101));
      socket.on('unexpected-response', (_request, response) =>
        resolve(response.statusCode ?? 0),
      );
      socket.on('error', () => resolve(0));
    });
    expect(status).toBe(401);
    expect(dev.requests).toHaveLength(0);
  });

  it('refuses session processes', async () => {
    peerUid = SESSION_UID;
    const response = await rawRequest(app.port, 'GET', '/', {
      host,
      'cf-access-jwt-assertion': access.token({ aud: [PREVIEW_AUD] }),
    });
    expect(response.status).toBe(403);
    expect(dev.requests).toHaveLength(0);
    // ...and on the management routes, including the stop route.
    const stop = await postJson(
      app.port,
      '/api/sessions/s-1/previews/x/stop',
      {},
      { 'cf-access-jwt-assertion': access.token() },
    );
    expect(stop.status).toBe(403);
  });
});
