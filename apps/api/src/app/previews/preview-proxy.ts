import {
  Agent,
  request as httpRequest,
  type AgentOptions,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream';
import {
  clientResponseHeaders,
  hostOnlyCookie,
  upstreamRequestHeaders,
  type PreviewOrigins,
} from './preview-headers';
import {
  refuseUpgrade,
  sendPreviewPage,
  type PreviewPage,
} from './preview-pages';

/** Why the dev server could not be reached. */
export type UpstreamFailure =
  /** Nothing listens (connection refused or reset right away). */
  | 'not_running'
  /** No connection within the connect timeout. */
  | 'connect_timeout'
  /** The listener is not the session user's (or not on loopback). */
  | 'refused'
  /** No answer within the response timeout. */
  | 'response_timeout'
  /** The connection broke before an answer. */
  | 'broken';

export class UpstreamError extends Error {
  constructor(
    readonly failure: UpstreamFailure,
    message: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** Connects to the dev server; the socket is checked before it is handed out. */
export type UpstreamConnector = (
  callback: (error: Error | null, socket?: Socket) => void,
) => void;

/** Something to end when the preview stops. */
export interface Closable {
  destroy(): void;
}

/** A preview's dev server, as the proxy reaches it. */
export interface PreviewUpstream {
  port: number;
  /** Opens a checked connection (see `previews.service.ts`). */
  connect: UpstreamConnector;
  /** Keep-alive agent whose connections all come from `connect`. */
  agent: Agent;
  /** Registers a request or socket to destroy on stop; returns the unregistration. */
  track(resource: Closable): () => void;
}

/**
 * Time limits of the proxy (changeable for tests):
 * - `connectMs`: a dev server has this long to accept a connection;
 * - `responseMs`: and this long to start answering (first compiles of big
 *   projects take a while); streaming bodies then have no limit;
 * - `upgradeMs`: a WebSocket handshake has this long.
 */
export const PROXY_TIMEOUTS = {
  connectMs: 10_000,
  responseMs: 120_000,
  upgradeMs: 30_000,
};

/** HTTP agent whose connections come from an {@link UpstreamConnector}. */
export class UpstreamAgent extends Agent {
  constructor(
    private readonly connector: UpstreamConnector,
    options: AgentOptions = { keepAlive: true, keepAliveMsecs: 1000 },
  ) {
    super(options);
  }

  // Node's Agent accepts a connection asynchronously through the callback.
  override createConnection(
    _options: unknown,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    this.connector((error, socket) => callback?.(error, socket as Duplex));
    return undefined;
  }
}

function failureOf(error: unknown): UpstreamError {
  if (error instanceof UpstreamError) {
    return error;
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ECONNREFUSED' || code === 'EADDRNOTAVAIL') {
    return new UpstreamError('not_running', 'Nothing answers on the port');
  }
  return new UpstreamError(
    'broken',
    `The connection broke: ${(error as Error).message}`,
  );
}

/** The page for a failure, with the port and preview name. */
export function failurePage(error: UpstreamError, port: number): PreviewPage {
  switch (error.failure) {
    case 'not_running':
      return {
        status: 502,
        title: 'The dev server is not running',
        message: `Nothing answers on port ${port} yet. If Claude is starting it, this page reloads until it is up; if it stopped, ask Claude to start it again.`,
        retrySeconds: 5,
      };
    case 'connect_timeout':
      return {
        status: 504,
        title: 'The dev server does not answer',
        message: `Port ${port} accepted no connection within ${PROXY_TIMEOUTS.connectMs / 1000} seconds.`,
        retrySeconds: 10,
      };
    case 'response_timeout':
      return {
        status: 504,
        title: 'The dev server is too slow',
        message: `The dev server on port ${port} did not answer within ${PROXY_TIMEOUTS.responseMs / 1000} seconds.`,
        retrySeconds: 15,
      };
    case 'refused':
      return {
        status: 502,
        title: 'This port is not forwarded',
        message: error.message,
      };
    case 'broken':
      return {
        status: 502,
        title: 'The dev server closed the connection',
        message: `The dev server on port ${port} closed the connection without an answer.`,
        retrySeconds: 5,
      };
  }
}

/**
 * Forwards an HTTP request to the dev server and streams the answer back,
 * both bodies without buffering (backpressure through `pipe`). Until the
 * dev server answers, failures become one of the app's pages; afterwards a
 * broken connection ends the browser's response.
 */
export function forwardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  upstream: PreviewUpstream,
  origins: PreviewOrigins,
): void {
  const outgoing = httpRequest({
    host: 'localhost',
    port: upstream.port,
    method: request.method,
    path: request.url,
    headers: upstreamRequestHeaders(request.headers, origins),
    agent: upstream.agent,
    setHost: false,
  });
  let answered = false;
  const timer = setTimeout(
    () =>
      outgoing.destroy(
        new UpstreamError('response_timeout', 'No answer in time'),
      ),
    PROXY_TIMEOUTS.responseMs,
  );
  const untrack = upstream.track({
    destroy: () => {
      outgoing.destroy();
      response.destroy();
    },
  });
  const done = () => {
    clearTimeout(timer);
    untrack();
  };
  outgoing.on('response', (answer) => {
    clearTimeout(timer);
    answered = true;
    response.writeHead(
      answer.statusCode ?? 502,
      answer.statusMessage,
      clientResponseHeaders(answer.headers, origins),
    );
    response.flushHeaders();
    pipeline(answer, response, (error) => {
      if (error) {
        outgoing.destroy();
        response.destroy();
      }
    });
  });
  outgoing.on('error', (error) => {
    clearTimeout(timer);
    if (answered) {
      response.destroy();
    } else {
      sendPreviewPage(
        request,
        response,
        failurePage(failureOf(error), upstream.port),
      );
    }
  });
  response.on('close', () => {
    if (!response.writableFinished) {
      outgoing.destroy();
    }
    done();
  });
  request.pipe(outgoing);
}

/** Serializes a response head for a raw socket. */
function responseHead(
  status: number,
  message: string | undefined,
  rawHeaders: string[],
  extra: string[] = [],
): string {
  const lines = [`HTTP/1.1 ${status} ${message ?? ''}`.trimEnd()];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    lines.push(
      `${name}: ${name.toLowerCase() === 'set-cookie' ? hostOnlyCookie(value) : value}`,
    );
  }
  return `${[...lines, ...extra].join('\r\n')}\r\n\r\n`;
}

const NON_UPGRADE_DROPPED = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Forwards a WebSocket upgrade (hot reload) and then the connection's bytes
 * both ways. A dev server that refuses the upgrade gets its answer passed
 * on; one that is not reachable gets a plain error answer.
 */
export function forwardUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  upstream: PreviewUpstream,
  origins: PreviewOrigins,
): void {
  const outgoing = httpRequest({
    host: 'localhost',
    port: upstream.port,
    method: request.method,
    path: request.url,
    headers: upstreamRequestHeaders(request.headers, origins, {
      upgrade: true,
    }),
    setHost: false,
    createConnection: ((
      _options: unknown,
      callback: (error: Error | null, socket?: Socket) => void,
    ) => {
      upstream.connect(callback);
      return undefined;
    }) as never,
  });
  const sockets: Duplex[] = [socket];
  const untrack = upstream.track({
    destroy: () => {
      outgoing.destroy();
      for (const each of sockets) {
        each.destroy();
      }
    },
  });
  const timer = setTimeout(
    () =>
      outgoing.destroy(
        new UpstreamError('response_timeout', 'No WebSocket handshake in time'),
      ),
    PROXY_TIMEOUTS.upgradeMs,
  );
  let settled = false;
  const closeAll = () => {
    clearTimeout(timer);
    for (const each of sockets) {
      each.destroy();
    }
    untrack();
  };
  socket.on('error', closeAll);
  socket.on('close', () => {
    if (!settled) {
      outgoing.destroy();
    }
    closeAll();
  });
  outgoing.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
    settled = true;
    clearTimeout(timer);
    sockets.push(upstreamSocket);
    upstreamSocket.on('error', closeAll);
    upstreamSocket.on('close', closeAll);
    socket.write(
      responseHead(
        answer.statusCode ?? 101,
        answer.statusMessage,
        answer.rawHeaders,
      ),
    );
    if (upstreamHead.length > 0) {
      socket.write(upstreamHead);
    }
    if (head.length > 0) {
      upstreamSocket.write(head);
    }
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  outgoing.on('response', (answer) => {
    // The dev server refused the upgrade: pass its answer on, then close.
    settled = true;
    clearTimeout(timer);
    const raw: string[] = [];
    for (let index = 0; index + 1 < answer.rawHeaders.length; index += 2) {
      if (!NON_UPGRADE_DROPPED.has(answer.rawHeaders[index].toLowerCase())) {
        raw.push(answer.rawHeaders[index], answer.rawHeaders[index + 1]);
      }
    }
    socket.write(
      responseHead(answer.statusCode ?? 502, answer.statusMessage, raw, [
        'Connection: close',
      ]),
    );
    answer.pipe(socket);
    answer.on('error', closeAll);
  });
  outgoing.on('error', (error) => {
    if (settled) {
      closeAll();
      return;
    }
    settled = true;
    clearTimeout(timer);
    refuseUpgrade(socket, failurePage(failureOf(error), upstream.port));
    untrack();
  });
  outgoing.end();
}
