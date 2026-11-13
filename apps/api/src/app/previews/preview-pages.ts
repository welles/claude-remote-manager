import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * Pages the app itself answers with on preview host names: unknown or
 * stopped previews, refused requests, and a dev server that is not up,
 * went away or does not answer. Plain, self-contained HTML (no scripts,
 * nothing loaded), never cached; a dev server that is not up yet gets a
 * page that reloads itself.
 */
export interface PreviewPage {
  status: number;
  title: string;
  message: string;
  /** Reload after this many seconds (navigations only). */
  retrySeconds?: number;
  headers?: Record<string, string>;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  410: 'Gone',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/** CSP of the app's own preview pages: nothing but inline styles. */
export const PREVIEW_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ] as string,
  );

export function previewPageHtml(page: PreviewPage): string {
  const refresh = page.retrySeconds
    ? `<meta http-equiv="refresh" content="${page.retrySeconds}">`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}<title>${escapeHtml(page.title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;color:#1d1b20;background:#fef7ff}
@media (prefers-color-scheme:dark){body{color:#e6e0e9;background:#141218}}
main{max-width:36rem;margin:10vh auto}
h1{font-size:1.25rem;margin:0 0 8px}
p{margin:0 0 8px}
small{opacity:.7}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(page.title)}</h1>
<p>${escapeHtml(page.message)}</p>
${page.retrySeconds ? `<p><small>This page reloads every ${page.retrySeconds} seconds.</small></p>` : ''}
<p><small>Claude Remote Manager preview</small></p>
</main>
</body>
</html>
`;
}

function wantsHtml(request: IncomingMessage): boolean {
  const accept = request.headers['accept'] ?? '';
  return request.method === 'GET' && accept.includes('text/html');
}

/** Answers an HTTP request with a page (HTML for navigations, else text). */
export function sendPreviewPage(
  request: IncomingMessage,
  response: ServerResponse,
  page: PreviewPage,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const html = wantsHtml(request);
  const body = html
    ? previewPageHtml(page)
    : `${page.title}: ${page.message}\n`;
  response.writeHead(page.status, {
    'content-type': html
      ? 'text/html; charset=utf-8'
      : 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'content-security-policy': PREVIEW_PAGE_CSP,
    'x-content-type-options': 'nosniff',
    ...(page.retrySeconds && !html
      ? { 'retry-after': String(page.retrySeconds) }
      : {}),
    ...page.headers,
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

/** Refuses a WebSocket upgrade with a plain HTTP answer and closes the socket. */
export function refuseUpgrade(socket: Duplex, page: PreviewPage): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = `${page.title}: ${page.message}\n`;
  socket.end(
    `HTTP/1.1 ${page.status} ${STATUS_TEXT[page.status] ?? 'Error'}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'Cache-Control: no-store\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.once('finish', () => socket.destroy());
}
