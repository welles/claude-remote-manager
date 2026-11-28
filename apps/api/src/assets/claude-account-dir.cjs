#!/usr/bin/env node
// Prepares and removes the Claude Code configuration directory of a further
// account for the session manager. Runs as the session user (separate-users
// mode), who owns these directories, so the API never writes into them
// with its own privileges.
//
//   claude-account-dir.cjs prepare <mainDir> <mainStateFile> <id>
//     Creates <mainDir>/crm-accounts/<id> (and the shared directories in
//     <mainDir>), links every shared entry of <mainDir> into it (relative
//     symlinks; existing entries are left alone) and copies `mcpServers`
//     of <mainStateFile> into the account's `.claude.json` when they
//     differ and Claude Code does not hold its lock.
//
//   claude-account-dir.cjs remove <mainDir> <id>
//     Removes <mainDir>/crm-accounts/<id> (symlinks, not their targets).
//
// Refuses an accounts directory or account directory that is a symlink.
// Writes one JSON line: {"ok":true} or {"ok":false,"message":...}.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ACCOUNTS = 'crm-accounts';
const OWN = new Set([ACCOUNTS, 'backups', 'statsig', '.last-cleanup']);
const OWN_PREFIXES = ['.credentials.json', '.claude.json'];
const SHARED_DIRECTORIES = [
  'projects',
  'skills',
  'plugins',
  'agents',
  'commands',
  'todos',
  'tasks',
  'plans',
  'session-env',
  'shell-snapshots',
  'file-history',
];
/** proper-lockfile's default: a lock not refreshed for this long is stale. */
const STALE_LOCK_MS = 10_000;
const ID = /^[0-9a-f-]{36}$/;

const done = (header) => process.stdout.write(`${JSON.stringify(header)}\n`);

const isOwn = (name) =>
  OWN.has(name) || OWN_PREFIXES.some((prefix) => name.startsWith(prefix));

/**
 * Creates a directory, or checks that one is there. `followLinks`: a
 * symlink to a directory counts (the user's own directories, e.g. skills
 * from a dotfiles repository); without it only a real directory does (the
 * app's own `crm-accounts` and account directories).
 */
function directory(dir, followLinks = false) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
  const stats = followLinks ? fs.statSync(dir) : fs.lstatSync(dir);
  if (!stats.isDirectory()) {
    throw new Error(`${dir} is not a directory`);
  }
}

/** A JSON object file: the object, `null` if missing, `undefined` if invalid. */
function readJson(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    if (error.code === 'ELOOP') {
      return undefined;
    }
    throw error;
  }
  try {
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

function prepare(mainDir, mainStateFile, id) {
  const root = path.join(mainDir, ACCOUNTS);
  const dir = path.join(root, id);
  directory(mainDir, true);
  directory(root);
  directory(dir);
  for (const name of SHARED_DIRECTORIES) {
    directory(path.join(mainDir, name), true);
  }
  // So that a setting changed in a further account's session lands in the
  // shared file, not in one of its own.
  try {
    fs.writeFileSync(path.join(mainDir, 'settings.json'), '{}\n', {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
  for (const name of fs.readdirSync(mainDir)) {
    if (isOwn(name)) {
      continue;
    }
    try {
      fs.symlinkSync(path.join('..', '..', name), path.join(dir, name));
    } catch (error) {
      // There already: a link, or an entry Claude Code made itself.
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
  copyMcpServers(mainStateFile, dir);
}

function copyMcpServers(mainStateFile, dir) {
  const main = readJson(mainStateFile);
  if (main === undefined) {
    return;
  }
  const file = path.join(dir, '.claude.json');
  // Claude Code's own lock (proper-lockfile: a directory next to the file),
  // taken atomically for the whole read-modify-write. Held by Claude Code:
  // the next start copies them.
  const lock = `${file}.lock`;
  if (!takeLock(lock)) {
    return;
  }
  try {
    writeServers(file, main);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Takes the lock directory; one older than proper-lockfile's stale time
 * (a holder that was killed) is taken over. Returns whether it got it.
 */
function takeLock(lock) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lock);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
    let stats;
    try {
      stats = fs.statSync(lock);
    } catch {
      continue;
    }
    if (Date.now() - stats.mtimeMs < STALE_LOCK_MS) {
      return false;
    }
    fs.rmSync(lock, { recursive: true, force: true });
  }
  return false;
}

function writeServers(file, main) {
  const state = readJson(file);
  if (state === undefined) {
    return;
  }
  const servers = main ? main.mcpServers : undefined;
  const current = state ?? {};
  if (
    JSON.stringify(current.mcpServers ?? null) ===
    JSON.stringify(servers ?? null)
  ) {
    return;
  }
  if (servers === undefined) {
    delete current.mcpServers;
  } else {
    current.mcpServers = servers;
  }
  const temporary = `${file}.crm-${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function remove(mainDir, id) {
  const root = path.join(mainDir, ACCOUNTS);
  let stats;
  try {
    stats = fs.lstatSync(root);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new Error(`${root} is not a directory`);
  }
  fs.rmSync(path.join(root, id), { recursive: true, force: true });
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare' && args.length === 3 && ID.test(args[2])) {
    prepare(args[0], args[1], args[2]);
  } else if (command === 'remove' && args.length === 2 && ID.test(args[1])) {
    remove(args[0], args[1]);
  } else {
    throw new Error(
      'usage: prepare <mainDir> <mainStateFile> <id> | remove <mainDir> <id>',
    );
  }
  done({ ok: true });
} catch (error) {
  done({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  });
}
