import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

/** What {@link heldByApiChild} reads from `/proc`; replaceable in tests. */
export interface ProcReader {
  /** IDs of all visible processes. */
  pids(): number[];
  /** Parent process ID; `null` if the process is gone. */
  parent(pid: number): number | null;
  /** The process's cgroup (unified hierarchy path); `null` if unknown. */
  cgroup(pid: number): string | null;
  /** Targets of the process's file descriptors (`socket:[123]`, paths). */
  descriptors(pid: number): string[];
}

/** Path in the unified cgroup hierarchy from `/proc/<pid>/cgroup`. */
export function cgroupPath(content: string): string | null {
  const lines = content.split('\n');
  const unified = lines.find((line) => line.startsWith('0::'));
  if (unified) {
    return unified.slice(3).trim() || null;
  }
  // cgroup v1: systemd's own hierarchy names the unit.
  const systemd = lines.find((line) => line.includes(':name=systemd:'));
  return systemd ? systemd.split(':name=systemd:')[1]?.trim() || null : null;
}

export const PROC: ProcReader = {
  pids: () =>
    readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .map(Number),
  parent: (pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // pid (comm) state ppid ...; comm may contain spaces and parentheses.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(fields[1]);
      return Number.isInteger(ppid) ? ppid : null;
    } catch {
      return null;
    }
  },
  cgroup: (pid) => {
    try {
      return cgroupPath(readFileSync(`/proc/${pid}/cgroup`, 'utf8'));
    } catch {
      return null;
    }
  },
  descriptors: (pid) => {
    try {
      return readdirSync(`/proc/${pid}/fd`).map((fd) => {
        try {
          return readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          return '';
        }
      });
    } catch {
      // Another user's process, or gone.
      return [];
    }
  },
};

/**
 * Whether the socket with inode `inode` is held by a process this API
 * started, directly or indirectly: Claude Code of a session, its tools,
 * setup scripts, dev servers. Used when sessions run as the API's own user
 * (`single-user`), where the socket's owner cannot tell a session from the
 * user's other programs (a browser on the same machine).
 *
 * A process counts when it descends from the API's process, or, when the
 * API runs in a cgroup of its own (a systemd service, `*.service`), when it
 * is in that cgroup or below: processes that detached from the API
 * (double fork, `setsid`) stay in the service's cgroup. A shell scope of a
 * terminal is not used that way (in development the API shares it with
 * the Angular dev server, which proxies the web app's requests). The API's
 * own process (tests calling it in-process) never counts.
 *
 * This keeps a session from calling the management API by accident or on
 * a whim (e.g. approving its own requests); it is no boundary against a
 * session that tries hard: with the user's rights it can leave the
 * service's cgroup (`systemd-run --user`) or read the API's files.
 */
export function heldByApiChild(
  inode: number,
  proc: ProcReader = PROC,
  self: number = process.pid,
): boolean {
  return inode > 0 && apiChildrenHolding([inode], proc, self, true).length > 0;
}

/**
 * The processes the API started (see {@link heldByApiChild}) that hold one
 * of the sockets `inodes`; with `first`, it stops at the first one.
 */
export function apiChildrenHolding(
  inodes: readonly number[],
  proc: ProcReader = PROC,
  self: number = process.pid,
  first = false,
): number[] {
  const targets = new Set(inodes.map((inode) => `socket:[${inode}]`));
  const found: number[] = [];
  if (targets.size === 0) {
    return found;
  }
  const ownCgroup = proc.cgroup(self);
  const serviceCgroup = ownCgroup?.endsWith('.service') ? ownCgroup : null;
  const parents = new Map<number, number | null>();
  const parentOf = (pid: number) => {
    if (!parents.has(pid)) {
      parents.set(pid, proc.parent(pid));
    }
    return parents.get(pid) ?? null;
  };
  const descendsFromApi = (pid: number) => {
    const seen = new Set<number>();
    let current: number | null = parentOf(pid);
    while (current !== null && current > 0 && !seen.has(current)) {
      if (current === self) {
        return true;
      }
      seen.add(current);
      current = parentOf(current);
    }
    return false;
  };
  const inServiceCgroup = (pid: number) => {
    if (!serviceCgroup) {
      return false;
    }
    const cgroup = proc.cgroup(pid);
    return (
      cgroup !== null &&
      (cgroup === serviceCgroup || cgroup.startsWith(`${serviceCgroup}/`))
    );
  };
  for (const pid of proc.pids()) {
    if (pid === self) {
      continue;
    }
    if (!descendsFromApi(pid) && !inServiceCgroup(pid)) {
      continue;
    }
    if (proc.descriptors(pid).some((target) => targets.has(target))) {
      found.push(pid);
      if (first) {
        break;
      }
    }
  }
  return found;
}
