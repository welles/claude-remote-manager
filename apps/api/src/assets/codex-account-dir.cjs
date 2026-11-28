#!/usr/bin/env node
// Prepares and removes the Codex home of a ChatGPT account for the session
// manager. Runs as the session user (separate-users mode), who owns these
// directories, so the API never writes into them with its own privileges.
//
//   codex-account-dir.cjs prepare <baseHome> <id>
//     Creates <baseHome>/crm-accounts/<id> with its own login (`auth.json`)
//     and state databases, and links what all accounts share from
//     <baseHome>: the configuration, instructions, prompts, skills and the
//     conversations (rollouts), so a session resumes another account's
//     thread by its path. Existing entries are left alone.
//
//   codex-account-dir.cjs remove <baseHome> <id>
//     Removes <baseHome>/crm-accounts/<id> (symlinks, not their targets).
//
// Refuses an accounts directory or account directory that is a symlink.
// Writes one JSON line: {"ok":true} or {"ok":false,"message":...}.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ACCOUNTS = 'crm-accounts';
/** Shared directories, created in the base home when missing. */
const SHARED_DIRECTORIES = ['sessions', 'archived_sessions', 'prompts', 'skills', 'rules'];
/** Shared files, linked when the base home has them. */
const SHARED_FILES = ['config.toml', 'AGENTS.md', 'hooks.json'];
const ID = /^[0-9a-f-]{36}$/;

const done = (header) => process.stdout.write(`${JSON.stringify(header)}\n`);

/**
 * Creates a directory, or checks that one is there; `followLinks`: a
 * symlink to a directory counts (the user's own base home).
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

function link(target, at) {
  try {
    fs.symlinkSync(target, at);
  } catch (error) {
    // There already: a link, or an entry Codex made itself.
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

function prepare(baseHome, id) {
  const root = path.join(baseHome, ACCOUNTS);
  const dir = path.join(root, id);
  directory(baseHome, true);
  directory(root);
  directory(dir);
  for (const name of SHARED_DIRECTORIES) {
    directory(path.join(baseHome, name), true);
    link(path.join('..', '..', name), path.join(dir, name));
  }
  for (const name of SHARED_FILES) {
    if (fs.existsSync(path.join(baseHome, name))) {
      link(path.join('..', '..', name), path.join(dir, name));
    }
  }
}

function remove(baseHome, id) {
  const root = path.join(baseHome, ACCOUNTS);
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
  if (command === 'prepare' && args.length === 2 && ID.test(args[1])) {
    prepare(args[0], args[1]);
  } else if (command === 'remove' && args.length === 2 && ID.test(args[1])) {
    remove(args[0], args[1]);
  } else {
    throw new Error('usage: prepare|remove <baseHome> <id>');
  }
  done({ ok: true });
} catch (error) {
  done({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  });
}
