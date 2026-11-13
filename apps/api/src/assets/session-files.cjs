#!/usr/bin/env node
// Reads and lists files of a session's directories for the session manager.
// Runs as the session user (separate-users mode), so it can read only what
// the session itself can read, and the API never opens session files with
// its own privileges.
//
//   session-files.cjs read <maxBytes> <path> <root>...
//     Opens <path> (relative paths: against the first root), follows
//     symlinks, and refuses anything whose real path is not inside one of
//     the roots, or that is not a regular file (directories, FIFOs,
//     sockets, devices). The check is made on the opened file itself
//     (/proc/self/fd), so swapping a path component between check and read
//     cannot redirect it. Writes one JSON line, then up to <maxBytes> bytes
//     of content.
//
//   session-files.cjs list <maxEntries> <root>
//     Lists the files below <root> (not following symlinked directories,
//     skipping .git and node_modules). Writes one JSON line, then the
//     relative paths, each followed by a NUL byte.
//
// The JSON line is {"ok":true,...} or {"ok":false,"code":...,"message":...}
// with code one of: usage, outside, not_found, not_regular, no_access,
// failed.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const out = (header, body) => {
  process.stdout.write(`${JSON.stringify(header)}\n`);
  if (body && body.length > 0) {
    process.stdout.write(body);
  }
};
const fail = (code, message) => out({ ok: false, code, message });

const inside = (real, roots) =>
  roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`));

function realRoots(list) {
  const roots = [];
  for (const root of list) {
    try {
      roots.push(fs.realpathSync(root));
    } catch {
      // A root that is gone allows nothing.
    }
  }
  return roots;
}

function errorCode(error) {
  switch (error && error.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'not_found';
    case 'EACCES':
    case 'EPERM':
      return 'no_access';
    case 'ELOOP':
      return 'outside';
    default:
      return 'failed';
  }
}

/** Real path of an open file descriptor. */
function fdPath(fd, target, stats) {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    // Without /proc: the target's real path, if it is the same file.
    const real = fs.realpathSync(target);
    const check = fs.statSync(real);
    if (check.dev !== stats.dev || check.ino !== stats.ino) {
      throw Object.assign(new Error('The file changed while it was opened'), {
        code: 'ELOOP',
      });
    }
    return real;
  }
}

function read(maxBytes, requested, rootList) {
  const roots = realRoots(rootList);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || roots.length === 0) {
    fail('usage', 'No session directory to read from');
    return;
  }
  if (!requested || requested.includes('\0')) {
    fail('usage', 'Invalid path');
    return;
  }
  const target = path.resolve(roots[0], requested);
  let fd;
  try {
    // O_NONBLOCK: opening a FIFO must not block; it is refused below.
    fd = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY,
    );
  } catch (error) {
    const code = errorCode(error);
    if (code === 'not_found') {
      // Only say "not found" for paths inside the session's directories.
      let parent = null;
      try {
        parent = fs.realpathSync(path.dirname(target));
      } catch {
        // The directory does not exist either.
      }
      if (!parent || !inside(parent, roots)) {
        fail('outside', `${requested} is not inside the session's directories`);
        return;
      }
    }
    fail(code, String((error && error.message) || error));
    return;
  }
  try {
    const stats = fs.fstatSync(fd);
    const real = fdPath(fd, target, stats);
    if (!inside(real, roots)) {
      fail('outside', `${requested} is not inside the session's directories`);
      return;
    }
    if (!stats.isFile()) {
      fail('not_regular', `${requested} is not a regular file`);
      return;
    }
    const wanted = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(wanted);
    let length = 0;
    while (length < wanted) {
      const count = fs.readSync(fd, buffer, length, wanted - length, length);
      if (count === 0) {
        break;
      }
      length += count;
    }
    out(
      {
        ok: true,
        path: real,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        length,
        truncated: stats.size > length,
      },
      buffer.subarray(0, length),
    );
  } catch (error) {
    fail(errorCode(error), String((error && error.message) || error));
  } finally {
    fs.closeSync(fd);
  }
}

const SKIPPED = new Set(['.git', 'node_modules']);
const MAX_DEPTH = 32;

function list(maxEntries, root) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || !root) {
    fail('usage', 'Usage: list <maxEntries> <root>');
    return;
  }
  const paths = [];
  let truncated = false;
  const visit = (dir, prefix, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (paths.length >= maxEntries) {
        truncated = true;
        return;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name) && depth < MAX_DEPTH) {
          visit(path.join(dir, entry.name), relative, depth + 1);
        }
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        paths.push(relative);
      }
    }
  };
  try {
    fs.accessSync(root, fs.constants.R_OK);
  } catch (error) {
    fail(errorCode(error), String((error && error.message) || error));
    return;
  }
  visit(root, '', 0);
  out(
    { ok: true, count: paths.length, truncated },
    paths.length > 0 ? Buffer.from(`${paths.join('\0')}\0`) : null,
  );
}

const [mode, limit, ...rest] = process.argv.slice(2);
if (mode === 'read' && rest.length >= 2) {
  read(Number(limit), rest[0], rest.slice(1));
} else if (mode === 'list' && rest.length === 1) {
  list(Number(limit), rest[0]);
} else {
  fail('usage', 'Usage: read <maxBytes> <path> <root>... | list <max> <root>');
}
