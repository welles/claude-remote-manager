import { isLoopback, loopbackPeerUid } from './peer-credentials';

const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0
   1: 0100007F:A1B2 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1001        0 2 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:0BB8 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 3 1 0000000000000000 20 4 30 10 -1
`;

describe('loopbackPeerUid', () => {
  it('finds the owner of the client socket', () => {
    expect(loopbackPeerUid(0xa1b2, 3000, () => [TCP])).toBe(1001);
    expect(loopbackPeerUid(0xa1b3, 3000, () => [TCP])).toBeNull();
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

  it('recognizes loopback addresses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('172.17.0.1')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});
