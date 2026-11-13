import { extname } from 'node:path';
import type { ShownFileKind } from '@claude-remote-manager/shared-types';
import { sniffImageType } from '../attachments/image-type';

/** Syntax highlighting language (highlight.js names) by file extension. */
const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'xml',
  '.htm': 'xml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.sql': 'sql',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.diff': 'diff',
  '.patch': 'diff',
  '.lua': 'lua',
  '.r': 'r',
  '.pl': 'perl',
  '.nix': 'nix',
};

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
]);

/** Whether a path names an image the viewer shows (by extension). */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

/** Text: no NUL byte and valid UTF-8 (of what was read). */
export function isText(data: Buffer, complete: boolean): boolean {
  if (data.includes(0)) {
    return false;
  }
  // A cut file may end inside a multi-byte character.
  const sample = complete
    ? data
    : data.subarray(0, Math.max(0, data.length - 4));
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

/**
 * How a file is shown, from its name and content: images by their content
 * (SVG by name, as text), PDFs by their signature, HTML and Markdown by
 * name, other UTF-8 text with highlighting, everything else as download.
 * HTML and SVG are only ever served sandboxed (see the controller).
 */
export function classifyFile(
  name: string,
  data: Buffer,
  complete: boolean,
): { kind: ShownFileKind; mediaType: string; language: string | null } {
  const extension = extname(name).toLowerCase();
  const image = sniffImageType(data);
  if (image) {
    return { kind: 'image', mediaType: image, language: null };
  }
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { kind: 'pdf', mediaType: 'application/pdf', language: null };
  }
  if (!isText(data, complete)) {
    return {
      kind: 'binary',
      mediaType: 'application/octet-stream',
      language: null,
    };
  }
  const language = LANGUAGES[extension] ?? null;
  if (extension === '.svg') {
    return { kind: 'image', mediaType: 'image/svg+xml', language };
  }
  if (extension === '.html' || extension === '.htm') {
    return { kind: 'html', mediaType: 'text/html; charset=utf-8', language };
  }
  if (extension === '.md' || extension === '.markdown') {
    return {
      kind: 'markdown',
      mediaType: 'text/plain; charset=utf-8',
      language,
    };
  }
  return { kind: 'text', mediaType: 'text/plain; charset=utf-8', language };
}
