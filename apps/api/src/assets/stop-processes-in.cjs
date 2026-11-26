#!/usr/bin/env node
// Stops the processes that run in a directory, for the session manager
// before it removes a session's clone or scratch directory: dev servers,
// watchers and test runners that Claude started there would otherwise write
// files again (caches such as node_modules/.vite) while the directory is
// deleted. Runs as the session user (separate-users mode): it sees and
// signals only that user's processes (the kernel refuses other signals, and
// other users' /proc/<pid>/cwd cannot be read).
//
//   stop-processes-in.cjs <graceMs> <sparedParentPid> <directory>
//     Finds this user's processes whose working directory is <directory>
//     or lies inside it, except this script, its parent and the direct
//     children of <sparedParentPid> (the session manager's Claude Code
//     processes, which the session manager ends or restarts itself), sends
//     them SIGTERM, and SIGKILL to those still running after <graceMs>.
//     Writes one JSON line: {"ok":true,"stopped":[pid,...]}.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const [graceArg, sparedArg, directory] = process.argv.slice(2);
const grace = Number(graceArg);
const spared = Number(sparedArg);
if (
  !Number.isInteger(grace) ||
  grace < 0 ||
  !Number.isInteger(spared) ||
  typeof directory !== 'string' ||
  !path.isAbsolute(directory) ||
  path.normalize(directory) !== directory ||
  directory.endsWith('/')
) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, message: 'usage: stop-processes-in.cjs <graceMs> <sparedParentPid> <directory>' })}\n`,
  );
  process.exit(2);
}

const DELETED = ' (deleted)';
const inside = (cwd) => {
  // A working directory that was removed already reads "<path> (deleted)".
  const plain = cwd.endsWith(DELETED) ? cwd.slice(0, -DELETED.length) : cwd;
  return plain === directory || plain.startsWith(`${directory}/`);
};
const parentOf = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name in parentheses may contain anything; fields follow
    // the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[1]);
  } catch {
    return -1;
  }
};

const uid = process.getuid();
const own = new Set([process.pid, process.ppid]);
const pids = [];
for (const entry of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(entry) || own.has(Number(entry))) {
    continue;
  }
  let cwd = '';
  try {
    if (fs.statSync(`/proc/${entry}`).uid !== uid) {
      continue;
    }
    cwd = fs.readlinkSync(`/proc/${entry}/cwd`);
  } catch {
    continue; // gone, or not readable
  }
  if (inside(cwd) && parentOf(entry) !== spared) {
    pids.push(Number(entry));
  }
}

// A process that ended but was not reaped yet (zombie, state Z) is gone.
const alive = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return (
      stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
    );
  } catch {
    return false;
  }
};
for (const pid of pids) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // gone already
  }
}
const deadline = Date.now() + grace;
const wait = () => {
  const left = pids.filter(alive);
  if (left.length === 0 || Date.now() >= deadline) {
    for (const pid of left) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone already
      }
    }
    process.stdout.write(`${JSON.stringify({ ok: true, stopped: pids })}\n`);
    return;
  }
  setTimeout(wait, 100);
};
wait();
