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
//     thread by its path. The shared configuration and instructions are
//     created empty in <baseHome> when missing, so they are always linked
//     (a file the user adds later applies to all accounts). Existing
//     entries are left alone; one that should be a link but is a file of
//     its own (e.g. Codex replaced the link by writing the file anew) is
//     kept, and reported as a warning.
//
//   codex-account-dir.cjs remove <baseHome> <id>
//     Removes <baseHome>/crm-accounts/<id> (symlinks, not their targets).
//
//   codex-account-dir.cjs homes <baseHome>
//     Lists the account homes: {"ok":true,"homes":["<baseHome>/crm-accounts/<id>",…]}
//     (directories with an account ID as name, no symlinks).
//
//   codex-account-dir.cjs remove-thread <baseHome> <threadId>
//     Removes the rollouts of a thread (a deleted session's conversation):
//     regular files named rollout-*-<threadId>.jsonl[.zst] in
//     <baseHome>/sessions/YYYY/MM/DD or <baseHome>/archived_sessions. Only
//     those directories themselves may be symlinks (the user's own base
//     home); nothing below them is followed.
//
// Refuses an accounts directory or account directory that is a symlink.
// Writes one JSON line: {"ok":true,"warnings":[...]} or
// {"ok":false,"message":...}.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ACCOUNTS = 'crm-accounts';
/** Shared directories, created in the base home when missing. */
const SHARED_DIRECTORIES = [
  'sessions',
  'archived_sessions',
  'prompts',
  'skills',
  'rules',
];
/** Shared files, created empty in the base home when missing. */
const SHARED_FILES = ['config.toml', 'AGENTS.md'];
/** Shared files, linked when the base home has them (empty is no JSON). */
const OPTIONAL_SHARED_FILES = ['hooks.json'];
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

/** Creates an empty file unless there is one (or a link to one). */
function emptyFile(file) {
  try {
    fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Links `at` to `target`; an entry there already stays. Returns a warning
 * when it is not a link (an own file of the account, not the shared one).
 */
function link(target, at) {
  try {
    fs.symlinkSync(target, at);
    return null;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
  return fs.lstatSync(at).isSymbolicLink()
    ? null
    : `${at} is not a link to the shared ${path.basename(at)}: the account uses its own (kept; merge it into the shared one and remove it to share it again)`;
}

function prepare(baseHome, id) {
  const root = path.join(baseHome, ACCOUNTS);
  const dir = path.join(root, id);
  const warnings = [];
  const share = (name) => {
    const warning = link(path.join('..', '..', name), path.join(dir, name));
    if (warning) {
      warnings.push(warning);
    }
  };
  directory(baseHome, true);
  directory(root);
  directory(dir);
  for (const name of SHARED_DIRECTORIES) {
    directory(path.join(baseHome, name), true);
    share(name);
  }
  for (const name of SHARED_FILES) {
    emptyFile(path.join(baseHome, name));
    share(name);
  }
  for (const name of OPTIONAL_SHARED_FILES) {
    if (fs.existsSync(path.join(baseHome, name))) {
      share(name);
    }
  }
  return warnings;
}

/** The rollouts of a thread under a directory, `depth` levels deep. */
function rollouts(dir, threadId, depth, found) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return found;
    }
    throw error;
  }
  for (const entry of entries) {
    const at = path.join(dir, entry.name);
    // withFileTypes reports symlinks as such: never followed.
    if (entry.isDirectory() && depth > 0) {
      rollouts(at, threadId, depth - 1, found);
    } else if (
      entry.isFile() &&
      entry.name.startsWith('rollout-') &&
      (entry.name.endsWith(`-${threadId}.jsonl`) ||
        entry.name.endsWith(`-${threadId}.jsonl.zst`))
    ) {
      found.push(at);
    }
  }
  return found;
}

function removeThread(baseHome, threadId) {
  const found = [
    ...rollouts(path.join(baseHome, 'sessions'), threadId, 3, []),
    ...rollouts(path.join(baseHome, 'archived_sessions'), threadId, 3, []),
  ];
  for (const file of found) {
    // Checked again right before: a regular file, not a link.
    if (fs.lstatSync(file).isFile()) {
      fs.unlinkSync(file);
    }
  }
  return found.length;
}

function homes(baseHome) {
  const root = path.join(baseHome, ACCOUNTS);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && ID.test(entry.name))
    .map((entry) => path.join(root, entry.name));
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
  let warnings = [];
  let removed;
  let found;
  if (command === 'prepare' && args.length === 2 && ID.test(args[1])) {
    warnings = prepare(args[0], args[1]);
  } else if (command === 'remove' && args.length === 2 && ID.test(args[1])) {
    remove(args[0], args[1]);
  } else if (command === 'homes' && args.length === 1) {
    found = homes(args[0]);
  } else if (
    command === 'remove-thread' &&
    args.length === 2 &&
    ID.test(args[1])
  ) {
    removed = removeThread(args[0], args[1]);
  } else {
    throw new Error(
      'usage: prepare|remove|remove-thread <baseHome> <id> | homes <baseHome>',
    );
  }
  done({
    ok: true,
    warnings,
    ...(removed === undefined ? {} : { removed }),
    ...(found === undefined ? {} : { homes: found }),
  });
} catch (error) {
  done({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  });
}
