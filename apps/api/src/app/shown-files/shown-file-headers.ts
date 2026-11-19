import type { ShownFileDto } from '@claude-remote-manager/shared-types';

/**
 * Content Security Policy of shown files served from the app's origin. The
 * content comes from the session (i.e. from whatever Claude or a
 * repository put there), so it must never run with the app's privileges:
 * `sandbox` gives every such document an opaque origin, also when it is
 * opened directly in a tab, so it cannot read the app's cookies or storage
 * or call the API as the app (its requests carry `Origin: null`, which the
 * request guard refuses); `default-src 'none'` lets it load nothing from
 * anywhere and connect nowhere.
 *
 * - HTML pages may run their own inline scripts (`sandbox allow-scripts`),
 *   e.g. for charts; they still cannot load or send anything, navigate
 *   the app or open pop-ups.
 * - SVG images get no scripts at all.
 * - PDFs are not sandboxed: the browsers' PDF viewers do not render
 *   sandboxed documents. They run in the browser's own viewer, not as
 *   pages of the app's origin.
 */
export const SANDBOX_CSP =
  "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'";
export const HTML_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; " +
  "media-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
export const PDF_CSP = "default-src 'none'; frame-ancestors 'self'";

/** `Content-Disposition` with a safe ASCII fallback and the UTF-8 name. */
export function contentDisposition(
  type: 'inline' | 'attachment',
  name: string,
): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Headers of a shown file's content. Inline only for what the viewer
 * shows in place (images, HTML in a sandboxed frame, PDFs, text it reads);
 * everything else, and every `download`, as attachment. Never sniffed.
 */
export function shownFileHeaders(
  file: Pick<ShownFileDto, 'kind' | 'mediaType' | 'name'>,
  size: number,
  download: boolean,
): Record<string, string> {
  const inline = !download && file.kind !== 'binary';
  return {
    'Content-Type': download ? 'application/octet-stream' : file.mediaType,
    'Content-Length': String(size),
    'Content-Disposition': contentDisposition(
      inline ? 'inline' : 'attachment',
      file.name,
    ),
    'Content-Security-Policy':
      file.kind === 'html'
        ? HTML_CSP
        : file.kind === 'pdf'
          ? PDF_CSP
          : SANDBOX_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'private, no-cache',
  };
}
