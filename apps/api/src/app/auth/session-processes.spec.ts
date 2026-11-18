import { createServer, connect, type Server, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { fromSessionProcess } from './authenticator';
import { loopbackPeer } from './peer-credentials';
import {
  cgroupPath,
  heldByApiChild,
  type ProcReader,
} from './session-processes';

/** A process table: pid → parent, cgroup and socket inodes. */
function fakeProc(
  processes: Record<
    number,
    { parent: number; cgroup: string; sockets?: number[] }
  >,
): ProcReader {
  return {
    pids: () => Object.keys(processes).map(Number),
    parent: (pid) => processes[pid]?.parent ?? null,
    cgroup: (pid) => processes[pid]?.cgroup ?? null,
    descriptors: (pid) =>
      (processes[pid]?.sockets ?? []).map((inode) => `socket:[${inode}]`),
  };
}

describe('cgroupPath', () => {
  it('reads the unified hierarchy, else systemd’s v1 hierarchy', () => {
    expect(cgroupPath('0::/system.slice/crm.service\n')).toBe(
      '/system.slice/crm.service',
    );
    expect(
      cgroupPath('12:cpu:/x\n1:name=systemd:/system.slice/crm.service\n'),
    ).toBe('/system.slice/crm.service');
    expect(cgroupPath('')).toBeNull();
  });
});

describe('heldByApiChild', () => {
  const service = '/system.slice/claude-remote-manager.service';
  const user =
    '/user.slice/user-1000.slice/user@1000.service/app.slice/x.scope';

  it('finds sockets of descendants and of detached processes in the service cgroup', () => {
    const proc = fakeProc({
      1: { parent: 0, cgroup: '/init.scope' },
      100: { parent: 1, cgroup: service, sockets: [7] },
      // Claude Code and a command it runs
      200: { parent: 100, cgroup: service },
      201: { parent: 200, cgroup: service, sockets: [11] },
      // a daemonized dev server: reparented to init, still in the service
      300: { parent: 1, cgroup: `${service}/sub`, sockets: [12] },
      // the user's browser
      400: { parent: 1, cgroup: user, sockets: [13] },
    });
    expect(heldByApiChild(11, proc, 100)).toBe(true);
    expect(heldByApiChild(12, proc, 100)).toBe(true);
    expect(heldByApiChild(13, proc, 100)).toBe(false);
    // The API's own socket (a test calling it in-process).
    expect(heldByApiChild(7, proc, 100)).toBe(false);
    expect(heldByApiChild(0, proc, 100)).toBe(false);
  });

  it('uses only the process tree when the API shares a terminal scope', () => {
    const proc = fakeProc({
      1: { parent: 0, cgroup: '/init.scope' },
      50: { parent: 1, cgroup: user },
      100: { parent: 50, cgroup: user },
      // Claude Code below the API
      200: { parent: 100, cgroup: user, sockets: [11] },
      // the Angular dev server's proxy, a sibling of the API
      300: { parent: 50, cgroup: user, sockets: [12] },
    });
    expect(heldByApiChild(11, proc, 100)).toBe(true);
    expect(heldByApiChild(12, proc, 100)).toBe(false);
  });
});

describe('fromSessionProcess', () => {
  const socket = {
    remotePort: 40000,
    localPort: 8080,
    remoteAddress: '127.0.0.1',
    localAddress: '127.0.0.1',
  };
  const separated = {
    mode: 'separate-users' as const,
    sessionUser: { name: 'claude', uid: 1001, gid: 1001, home: '/h' },
  };

  it('with separate users: the session user’s sockets', () => {
    expect(
      fromSessionProcess(separated, socket, () => ({ uid: 1001, inode: 1 })),
    ).toBe(true);
    expect(
      fromSessionProcess(separated, socket, () => ({ uid: 1000, inode: 1 })),
    ).toBe(false);
    // From outside this machine (a tunnel on another host).
    expect(fromSessionProcess(separated, socket, () => null)).toBe(false);
  });

  it('with one user: sockets of the API user held by processes the API started', () => {
    const single = { mode: 'single-user' as const };
    const check = (uid: number, started: boolean) =>
      fromSessionProcess(
        single,
        socket,
        () => ({ uid, inode: 5 }),
        (inode) => inode === 5 && started,
        1000,
      );
    expect(check(1000, true)).toBe(true);
    expect(check(1000, false)).toBe(false);
    expect(check(1001, true)).toBe(false);
    expect(fromSessionProcess(single, socket, () => null)).toBe(false);
  });
});

describe('a real connection from a child process', () => {
  let server: Server;
  let accepted: Promise<Socket>;

  beforeEach(async () => {
    server = createServer();
    accepted = new Promise((resolve) => server.once('connection', resolve));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
  });
  afterEach(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );

  const peerOf = (socket: Socket) =>
    loopbackPeer(socket.remotePort ?? 0, socket.localPort ?? 0, {
      client: socket.remoteAddress ?? '',
      server: socket.localAddress ?? '',
    });

  it('is recognized as started by the API; its own connection is not', async () => {
    const port = (server.address() as { port: number }).port;
    const child = spawn(process.execPath, [
      '-e',
      `require('net').connect(${port}, '127.0.0.1'); setTimeout(() => {}, 10000)`,
    ]);
    try {
      const socket = await accepted;
      const peer = peerOf(socket);
      expect(peer?.uid).toBe(process.getuid?.());
      expect(heldByApiChild(peer?.inode ?? 0)).toBe(true);
      expect(fromSessionProcess({ mode: 'single-user' }, socket)).toBe(true);
    } finally {
      child.kill();
    }

    accepted = new Promise((resolve) => server.once('connection', resolve));
    const own = connect(port, '127.0.0.1');
    try {
      const socket = await accepted;
      expect(heldByApiChild(peerOf(socket)?.inode ?? 0)).toBe(false);
      expect(fromSessionProcess({ mode: 'single-user' }, socket)).toBe(false);
    } finally {
      own.destroy();
    }
  });
});
