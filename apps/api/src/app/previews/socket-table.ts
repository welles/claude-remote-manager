import { readFileSync } from 'node:fs';

/**
 * The kernel's TCP socket tables (`/proc/net/tcp`, `/proc/net/tcp6`) of
 * this network namespace, which the API shares with the session
 * processes: who listens on a port (address and owner), and who owns the
 * other end of a connection the API made.
 */

/** A socket table line, parsed. */
export interface SocketEntry {
  /** Local address, e.g. `127.0.0.1`, `0.0.0.0`, `::1`, `::`. */
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  /** `0A` = LISTEN, `01` = ESTABLISHED. */
  state: string;
  uid: number;
  inode: number;
}

export const TCP_LISTEN = '0A';
export const TCP_ESTABLISHED = '01';

export type SocketTables = () => string[];

/** Reads both tables; a missing table (no IPv6) counts as empty. */
export const readSocketTables: SocketTables = () =>
  ['/proc/net/tcp', '/proc/net/tcp6'].map((file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  });

/** An IPv4 address of the table: one 32-bit word in host (little-endian) order. */
function ipv4(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  return [bytes[3], bytes[2], bytes[1], bytes[0]].join('.');
}

/** An IPv6 address of the table: four 32-bit words, each little-endian. */
function ipv6(hex: string): string {
  const bytes = Buffer.alloc(16);
  for (let word = 0; word < 4; word++) {
    Buffer.from(hex.slice(word * 8, word * 8 + 8), 'hex')
      .reverse()
      .copy(bytes, word * 4);
  }
  if (bytes.subarray(0, 10).every((byte) => byte === 0)) {
    if (bytes[10] === 0xff && bytes[11] === 0xff) {
      return `::ffff:${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    }
    if (bytes.subarray(10, 15).every((byte) => byte === 0)) {
      if (bytes[15] === 0) {
        return '::';
      }
      if (bytes[15] === 1) {
        return '::1';
      }
    }
  }
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(bytes.readUInt16BE(index).toString(16));
  }
  return groups.join(':');
}

function address(field: string): { address: string; port: number } {
  const [hex, port] = field.split(':');
  return {
    address: hex.length === 8 ? ipv4(hex) : ipv6(hex),
    port: parseInt(port ?? '', 16),
  };
}

/** All entries of the tables. */
export function socketEntries(
  tables: SocketTables = readSocketTables,
): SocketEntry[] {
  const entries: SocketEntry[] = [];
  for (const table of tables()) {
    for (const line of table.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) {
        continue;
      }
      const local = address(fields[1]);
      const remote = address(fields[2]);
      entries.push({
        localAddress: local.address,
        localPort: local.port,
        remoteAddress: remote.address,
        remotePort: remote.port,
        state: fields[3].toUpperCase(),
        uid: Number(fields[7]),
        inode: Number(fields[9]),
      });
    }
  }
  return entries;
}

/** Whether an address is reachable over loopback when bound to it. */
export function loopbackReachable(address: string): boolean {
  return (
    address === '0.0.0.0' ||
    address === '::' ||
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  );
}

/** The sockets listening on a port. */
export function listenersOn(
  port: number,
  tables: SocketTables = readSocketTables,
): SocketEntry[] {
  return socketEntries(tables).filter(
    (entry) => entry.state === TCP_LISTEN && entry.localPort === port,
  );
}

/**
 * Owner of the server end of a loopback connection this process made from
 * `clientPort` to `serverPort`: the socket the server accepted, whose
 * owner is the listening socket's. `null` when it is not (yet) in the
 * tables.
 */
export function acceptedSocketUid(
  serverPort: number,
  clientPort: number,
  tables: SocketTables = readSocketTables,
): number | null {
  const entry = socketEntries(tables).find(
    (candidate) =>
      candidate.state === TCP_ESTABLISHED &&
      candidate.localPort === serverPort &&
      candidate.remotePort === clientPort,
  );
  return entry ? entry.uid : null;
}
