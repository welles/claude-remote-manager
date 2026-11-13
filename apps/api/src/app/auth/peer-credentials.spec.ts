import { isLoopback, loopbackPeerUid } from './peer-credentials';

const TCP_BASE = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0
   1: 0100007F:A1B2 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1001        0 2 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:0BB8 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 3 1 0000000000000000 20 4 30 10 -1
`;

// 172.18.0.2:49152 -> 172.18.0.2:8080 (container address), uid 1001.
const TCP_ETH0 = `   3: 020012AC:C000 020012AC:1F90 01 00000000:00000000 00:00000000 00000000  1001        0 4 1 0000000000000000 20 4 30 10 -1
`;
const TCP = TCP_BASE + TCP_ETH0;
// [::1]:49153 -> [::1]:8080, uid 1001.
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:C001 00000000000000000000000001000000:1F90 01 00000000:00000000 00:00000000 00000000  1001        0 5 1 0000000000000000 20 4 30 10 -1
`;

describe('loopbackPeerUid', () => {
  it('finds the owner of the client socket', () => {
    expect(loopbackPeerUid(0xa1b2, 3000, undefined, () => [TCP])).toBe(1001);
    expect(loopbackPeerUid(0xa1b3, 3000, undefined, () => [TCP])).toBeNull();
  });

  it('compares the addresses when they are known', () => {
    const tables = () => [TCP, TCP6];
    const loop = { client: '127.0.0.1', server: '127.0.0.1' };
    expect(loopbackPeerUid(0xa1b2, 3000, loop, tables)).toBe(1001);
    // The container's own address (eth0), as IPv4 and IPv4-mapped IPv6.
    const eth0 = { client: '172.18.0.2', server: '172.18.0.2' };
    expect(loopbackPeerUid(0xc000, 8080, eth0, tables)).toBe(1001);
    expect(
      loopbackPeerUid(
        0xc000,
        8080,
        { client: '::ffff:172.18.0.2', server: '::ffff:172.18.0.2' },
        tables,
      ),
    ).toBe(1001);
    // Same ports, other addresses: a connection from outside whose port
    // happens to match a session's own outgoing connection.
    expect(
      loopbackPeerUid(
        0xc000,
        8080,
        { client: '172.18.0.1', server: '172.18.0.2' },
        tables,
      ),
    ).toBeNull();
    expect(
      loopbackPeerUid(0xc001, 8080, { client: '::1', server: '::1' }, tables),
    ).toBe(1001);
  });

  it('works on the real socket table', async () => {
    const { createServer, connect } = await import('node:net');
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;
    const peer = new Promise<number | null>((resolve) =>
      server.on('connection', (socket) =>
        resolve(loopbackPeerUid(socket.remotePort as number, port)),
      ),
    );
    const client = connect(port, '127.0.0.1');
    expect(await peer).toBe(process.getuid?.());
    client.destroy();
    server.close();
  });

  it('finds a peer that connected to a non-loopback address of this host', async () => {
    const { networkInterfaces } = await import('node:os');
    const own = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry && entry.family === 'IPv4' && !entry.internal);
    if (!own) {
      return; // no such interface here
    }
    const { createServer, connect } = await import('node:net');
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    const port = (server.address() as { port: number }).port;
    const peer = new Promise<number | null>((resolve) =>
      server.on('connection', (socket) =>
        resolve(
          loopbackPeerUid(socket.remotePort as number, port, {
            client: socket.remoteAddress as string,
            server: socket.localAddress as string,
          }),
        ),
      ),
    );
    const client = connect(port, own.address);
    expect(await peer).toBe(process.getuid?.());
    client.destroy();
    server.close();
  });

  it('recognizes loopback addresses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('172.17.0.1')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});
