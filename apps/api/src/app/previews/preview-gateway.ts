import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { Logger } from '@nestjs/common';
import { withinDomain, type PreviewConfig } from '../config/app-config';
import { hostName } from '../security/request-policy';
import type { PreviewAccess } from './preview-access';
import type { PreviewOrigins } from './preview-headers';
import {
  refuseUpgrade,
  sendPreviewPage,
  type PreviewPage,
} from './preview-pages';
import {
  forwardRequest,
  forwardUpgrade,
  type PreviewUpstream,
} from './preview-proxy';
import type { PreviewsService } from './previews.service';

function hostHeader(request: IncomingMessage): string | null {
  const host = request.headers['host'];
  return typeof host === 'string' && host ? host : null;
}

const UNKNOWN: PreviewPage = {
  status: 404,
  title: 'No preview here',
  message:
    'No preview has this address. Open the session in Claude Remote Manager for the current links.',
};
const STOPPED: PreviewPage = {
  status: 410,
  title: 'This preview was stopped',
  message:
    'The forwarding to this dev server ended. Ask Claude in the session to expose the port again.',
};

/**
 * Serves the preview host names, in front of the app: a request (or
 * WebSocket upgrade) whose `Host` lies in the preview domain is answered
 * here and never reaches Nest (no API routes, no web app, no `/api/ws`);
 * every other request never reaches a preview.
 *
 * - `<label>.<domain>` of an active preview: checked (see
 *   {@link PreviewAccess}), then forwarded to the dev server;
 * - anything else in the domain (unknown, stopped, deeper names, the
 *   domain itself): a plain page of the app;
 * - WebSocket upgrades must come from a page of a preview (any preview:
 *   a front end may talk to the back end of another port) or from a
 *   client without `Origin`, so other sites cannot open the dev servers'
 *   hot reload sockets.
 */
export class PreviewGateway {
  private readonly logger = new Logger('Previews');

  constructor(
    private readonly config: PreviewConfig,
    private readonly previews: PreviewsService,
    private readonly access: PreviewAccess,
  ) {}

  /** Whether a request belongs to the preview hosts. */
  handles(request: IncomingMessage): boolean {
    const host = hostHeader(request);
    return host !== null && withinDomain(hostName(host), this.config.domain);
  }

  /** The preview's label, or `null` for names that cannot be a preview. */
  private label(request: IncomingMessage): string | null {
    const name = hostName(hostHeader(request) ?? '').replace(/\.$/, '');
    const label = name.slice(0, -(this.config.domain.length + 1));
    return name.endsWith(`.${this.config.domain}`) &&
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)
      ? label
      : null;
  }

  private origins(request: IncomingMessage, port: number): PreviewOrigins {
    const host = hostHeader(request) ?? '';
    return { host, public: `${this.config.scheme}://${host}`, port };
  }

  async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const target = await this.admit(request);
    if ('page' in target) {
      sendPreviewPage(request, response, target.page);
      return;
    }
    forwardRequest(
      request,
      response,
      target.upstream,
      this.origins(request, target.upstream.port),
    );
  }

  async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const origin = request.headers['origin'];
    if (typeof origin === 'string' && !this.previewOrigin(origin)) {
      this.logger.warn(`Refused a preview WebSocket from ${origin}`);
      refuseUpgrade(socket, {
        status: 403,
        title: 'Refused',
        message: 'WebSockets of previews only open from preview pages',
      });
      return;
    }
    const target = await this.admit(request);
    if ('page' in target) {
      refuseUpgrade(socket, target.page);
      return;
    }
    forwardUpgrade(
      request,
      socket,
      head,
      target.upstream,
      this.origins(request, target.upstream.port),
    );
  }

  private previewOrigin(origin: string): boolean {
    try {
      return withinDomain(new URL(origin).hostname, this.config.domain);
    } catch {
      return false;
    }
  }

  /** The preview to forward to, or the page to answer with. */
  private async admit(
    request: IncomingMessage,
  ): Promise<{ upstream: PreviewUpstream } | { page: PreviewPage }> {
    const label = this.label(request);
    if (!label) {
      return { page: UNKNOWN };
    }
    const verdict = await this.access.check(
      request.headers,
      request.socket as Socket,
    );
    if (!verdict.ok) {
      return {
        page: {
          status: verdict.status,
          title: verdict.status === 401 ? 'Sign in first' : 'Access refused',
          message: verdict.message,
        },
      };
    }
    // Looked up after authenticating: unauthenticated requests learn
    // nothing about which previews exist.
    const resolved = this.previews.resolve(label);
    if (!resolved.found) {
      return { page: resolved.reason === 'stopped' ? STOPPED : UNKNOWN };
    }
    return { upstream: resolved.upstream };
  }
}

/**
 * Puts the gateway in front of everything the HTTP server does: requests
 * and upgrades for preview hosts go to the gateway before any other
 * listener (Express, the WebSocket server) sees them.
 */
export function installPreviewGateway(
  server: Server,
  gateway: PreviewGateway,
): void {
  const logger = new Logger('Previews');
  const emit = server.emit.bind(server) as (
    event: string | symbol,
    ...args: unknown[]
  ) => boolean;
  server.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
    if (event === 'request') {
      const [request, response] = args as [IncomingMessage, ServerResponse];
      if (gateway.handles(request)) {
        gateway.handleRequest(request, response).catch((error: unknown) => {
          logger.error(`Preview request failed: ${String(error)}`);
          sendPreviewPage(request, response, {
            status: 502,
            title: 'Preview failed',
            message: 'The request could not be forwarded.',
          });
        });
        return true;
      }
    } else if (event === 'upgrade') {
      const [request, socket, head] = args as [IncomingMessage, Duplex, Buffer];
      if (gateway.handles(request)) {
        gateway.handleUpgrade(request, socket, head).catch((error: unknown) => {
          logger.error(`Preview upgrade failed: ${String(error)}`);
          socket.destroy();
        });
        return true;
      }
    }
    return emit(event, ...args);
  }) as typeof server.emit;
}
