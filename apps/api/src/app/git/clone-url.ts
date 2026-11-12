import { isAbsolute, normalize } from 'node:path';

/** A clone URL that is not accepted; the message says why. */
export class InvalidCloneUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCloneUrlError';
  }
}

export interface ParsedCloneUrl {
  /** The URL as git gets it (trimmed; local paths normalized). */
  url: string;
  owner: string;
  name: string;
}

const MAX_URL_LENGTH = 500;

/**
 * Owner and repository names become directory names, so they are limited
 * to the characters GitHub allows and must not be `.` or `..`.
 */
export const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** `user@host:path` (scp-like syntax of git), but not `scheme://`. */
const SCP_PATTERN = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/;

/** Owner and name from the last two path segments (`.git` removed). */
function ownerAndName(path: string): { owner: string; name: string } {
  const segments = path
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  let name = segments.at(-1) ?? '';
  if (name.endsWith('.git')) {
    name = name.slice(0, -'.git'.length);
  }
  const owner = segments.length >= 2 ? segments[segments.length - 2] : 'local';
  for (const [label, value] of [
    ['repository name', name],
    ['owner', owner],
  ]) {
    if (!NAME_PATTERN.test(value) || value === '..') {
      throw new InvalidCloneUrlError(
        `The URL's ${label} "${value}" is not supported; use letters, digits, ".", "_" and "-"`,
      );
    }
  }
  return { owner, name };
}

/**
 * Validates a clone URL and derives owner and name from its last two path
 * segments. Accepted: `https://` and `ssh://` URLs, scp-like
 * `git@host:owner/name.git`, and absolute local paths (also `file://`).
 * Refused: other transports (plain HTTP, `git://`, `ext::`), credentials in
 * the URL, query strings, whitespace, and anything starting with `-`.
 */
export function parseCloneUrl(input: string): ParsedCloneUrl {
  const url = input.trim();
  if (!url) {
    throw new InvalidCloneUrlError('The clone URL is empty');
  }
  if (url.length > MAX_URL_LENGTH) {
    throw new InvalidCloneUrlError(
      `The clone URL is longer than ${MAX_URL_LENGTH} characters`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(url) || url.startsWith('-')) {
    throw new InvalidCloneUrlError(
      'The clone URL must not contain whitespace, control characters or backslashes, or start with "-"',
    );
  }

  if (url.includes('::')) {
    // `<transport>::<address>` makes git run a remote helper.
    throw new InvalidCloneUrlError(
      'Remote helper URLs (transport::address) are not supported',
    );
  }

  if (url.startsWith('/')) {
    const path = normalize(url).replace(/\/+$/, '');
    return { url: path, ...ownerAndName(path) };
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new InvalidCloneUrlError('The clone URL is not a valid URL');
    }
    if (parsed.search || parsed.hash) {
      throw new InvalidCloneUrlError(
        'The clone URL must not have a query or fragment',
      );
    }
    if (parsed.password || (parsed.protocol === 'https:' && parsed.username)) {
      throw new InvalidCloneUrlError(
        'Do not put credentials into the clone URL; configure git credentials or an SSH key instead',
      );
    }
    switch (parsed.protocol) {
      case 'https:':
      case 'ssh:':
        if (!parsed.hostname) {
          throw new InvalidCloneUrlError('The clone URL has no host');
        }
        return { url, ...ownerAndName(decodeURIComponent(parsed.pathname)) };
      case 'file:': {
        const path = normalize(decodeURIComponent(parsed.pathname));
        if (parsed.host || !isAbsolute(path)) {
          throw new InvalidCloneUrlError(
            'file:// URLs must name an absolute local path',
          );
        }
        return { url: path.replace(/\/+$/, ''), ...ownerAndName(path) };
      }
      default:
        throw new InvalidCloneUrlError(
          `Unsupported protocol ${parsed.protocol.slice(0, -1)}; use https, ssh or a local path`,
        );
    }
  }

  const scp = SCP_PATTERN.exec(url);
  if (scp) {
    return { url, ...ownerAndName(scp[3]) };
  }
  throw new InvalidCloneUrlError(
    'Use an https:// or ssh:// URL, git@host:owner/name.git or an absolute local path',
  );
}
