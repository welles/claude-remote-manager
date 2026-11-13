#!/usr/bin/env node
// Stops the processes that listen on given TCP ports, for the session
// manager when a session with previews ends. Runs as the session user
// (separate-users mode): it finds and signals only that user's processes
// (other users' /proc/<pid>/fd cannot be read, and the kernel refuses the
// signal).
//
//   stop-listeners.cjs <graceMs> <port>...
//     Finds the listening sockets on the ports owned by this user
//     (/proc/net/tcp, tcp6), the processes holding them (/proc/<pid>/fd),
//     sends them SIGTERM, and SIGKILL to those still running after
//     <graceMs>. Writes one JSON line: {"ok":true,"stopped":[pid,...]}.
'use strict';

const fs = require('node:fs');

const [graceArg, ...portArgs] = process.argv.slice(2);
const grace = Number(graceArg);
const ports = new Set(portArgs.map(Number));
if (!Number.isInteger(grace) || grace < 0 || ports.size === 0) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, message: 'usage: stop-listeners.cjs <graceMs> <port>...' })}\n`,
  );
  process.exit(2);
}
const uid = process.getuid();

const inodes = new Set();
for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
  let table = '';
  try {
    table = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) {
      continue;
    }
    const port = parseInt(fields[1].split(':')[1], 16);
    // 0A = LISTEN
    if (fields[3] === '0A' && ports.has(port) && Number(fields[7]) === uid) {
      inodes.add(fields[9]);
    }
  }
}

const own = new Set([process.pid, process.ppid]);
const pids = [];
if (inodes.size > 0) {
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || own.has(Number(entry))) {
      continue;
    }
    let fds = [];
    try {
      fds = fs.readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target = '';
      try {
        target = fs.readlinkSync(`/proc/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match && inodes.has(match[1])) {
        pids.push(Number(entry));
        break;
      }
    }
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
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
