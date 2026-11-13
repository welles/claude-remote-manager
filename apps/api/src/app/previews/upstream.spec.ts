import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { UpstreamError } from './preview-proxy';
import {
  acceptedSocketUid,
  listenersOn,
  readSocketTables,
  socketEntries,
} from './socket-table';
import { checkListener, portPolicy, upstreamConnector } from './upstream';

const HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const line = (local: string, remote: string, state: string, uid: number) =>
  `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000  ${uid}        0 4242 1 0000000000000000 100 0 0 10 0\n`;

describe('socket tables', () => {
  it('parses IPv4 and IPv6 entries', () => {
    const tables = () => [
      HEADER +
        line('0100007F:1435', '00000000:0000', '0A', 1001) +
        line('00000000:0BB8', '00000000:0000', '0A', 1000) +
        line('0100007F:1435', '0100007F:D431', '01', 1001),
      HEADER +
        line(
          '00000000000000000000000001000000:1F90',
          '00000000000000000000000000000000:0000',
          '0A',
          0,
        ) +
        line(
          '0000000000000000FFFF00000100007F:2328',
          '00000000000000000000000000000000:0000',
          '0A',
          1001,
        ) +
        line(
          '00000000000000000000000000000000:2329',
          '00000000000000000000000000000000:0000',
          '0A',
          1001,
        ),
    ];
    expect(
      socketEntries(tables).map((entry) => [
        entry.localAddress,
        entry.localPort,
        entry.state,
        entry.uid,
      ]),
    ).toEqual([
      ['127.0.0.1', 5173, '0A', 1001],
      ['0.0.0.0', 3000, '0A', 1000],
      ['127.0.0.1', 5173, '01', 1001],
      ['::1', 8080, '0A', 0],
      ['::ffff:127.0.0.1', 9000, '0A', 1001],
      ['::', 9001, '0A', 1001],
    ]);
    expect(listenersOn(5173, tables)).toHaveLength(1);
    expect(acceptedSocketUid(5173, 0xd431, tables)).toBe(1001);
    expect(acceptedSocketUid(5173, 1, tables)).toBeNull();
  });
});

describe('which listeners a preview may reach', () => {
  const isolation = {
    mode: 'separate-users' as const,
    sessionUser: { name: 'claude', uid: 1001, gid: 1001, home: '/home/claude' },
  };
  const policy = portPolicy(isolation, () => [8080]);
  const tables = () => [
    HEADER +
      line('0100007F:1435', '00000000:0000', '0A', 1001) + // 127.0.0.1:5173 session
      line('00000000:0BB8', '00000000:0000', '0A', 1001) + // 0.0.0.0:3000 session
      line('0100007F:1F90', '00000000:0000', '0A', 1000) + // 127.0.0.1:8080 API
      line('0100007F:1538', '00000000:0000', '0A', 0) + // 127.0.0.1:5432 root
      line('0500000A:1388', '00000000:0000', '0A', 1001), // 10.0.0.5:5000 session
    HEADER +
      line(
        '00000000000000000000000001000000:1771',
        '00000000000000000000000000000000:0000',
        '0A',
        1001,
      ), // [::1]:6001 session
  ];

  it('accepts the session user’s loopback listeners', () => {
    expect(checkListener(5173, policy, tables)).toEqual({
      ok: true,
      address: '127.0.0.1',
    });
    expect(checkListener(3000, policy, tables)).toEqual({
      ok: true,
      address: '127.0.0.1',
    });
    expect(checkListener(6001, policy, tables)).toEqual({
      ok: true,
      address: '::1',
    });
  });

  it('refuses the API’s port, other users, other addresses', () => {
    expect(checkListener(8080, policy, tables)).toMatchObject({
      ok: false,
      reason: 'forbidden',
    });
    expect(checkListener(5432, policy, tables)).toMatchObject({
      ok: false,
      reason: 'foreign',
      message: expect.stringContaining('uid 0'),
    });
    expect(checkListener(5000, policy, tables)).toMatchObject({
      ok: false,
      reason: 'not_loopback',
      message: expect.stringContaining('10.0.0.5'),
    });
    expect(checkListener(4000, policy, tables)).toMatchObject({
      ok: false,
      reason: 'nothing',
    });
    // An API listener on a port that is not its main one: wrong owner.
    const apiOther = () => [
      HEADER + line('0100007F:2710', '00000000:0000', '0A', 1000),
    ];
    expect(checkListener(10000, policy, apiOther)).toMatchObject({
      reason: 'foreign',
    });
  });
});

describe('connections to a dev server', () => {
  let server: Server;
  let port: number;
  const uid = process.getuid?.() ?? -1;
  const policy = portPolicy({ mode: 'single-user' }, () => []);

  beforeEach(async () => {
    server = createServer((_request, response) => response.end('ok'));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const connect = (tables = readSocketTables) =>
    new Promise<{ error: Error | null; socket?: Socket }>((resolve) =>
      upstreamConnector(
        port,
        policy,
        tables,
      )((error, socket) => resolve({ error, socket })),
    );

  it('hands out connections whose accepting socket belongs to the owner', async () => {
    const { error, socket } = await connect();
    expect(error).toBeNull();
    expect(socket?.remotePort).toBe(port);
    socket?.destroy();
  });

  it('refuses a connection accepted by another user’s socket', async () => {
    // The listener looks like ours, but the socket that accepted the
    // connection belongs to root (a listener swapped in after the check).
    const swapped = () =>
      readSocketTables().map((table) =>
        table
          .split('\n')
          .map((row) => {
            const fields = row.trim().split(/\s+/);
            if (
              fields.length > 9 &&
              fields[3] === '01' &&
              parseInt(fields[1].split(':')[1], 16) === port
            ) {
              fields[7] = '0';
              return fields.join(' ');
            }
            return row;
          })
          .join('\n'),
      );
    const { error } = await connect(swapped);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).failure).toBe('refused');
    expect(error?.message).toContain('uid 0');
    expect(uid).not.toBe(0);
  });

  it('says when nothing listens', async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const { error } = await connect();
    expect((error as UpstreamError).failure).toBe('not_running');
    server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
  });
});
