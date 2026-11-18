import { readFileSync } from 'node:fs';

/** Addresses of both ends of a connection, as the server socket sees them. */
export interface PeerAddresses {
  /** The client's address (the server socket's remote address). */
  client: string;
  /** The server's address the client connected to (its local address). */
  server: string;
}

/** The client socket of a connection: owner and inode. */
export interface PeerSocketEntry {
  uid: number;
  /** Inode of the client socket (to find the process that holds it). */
  inode: number;
}

/**
 * The client socket of a TCP connection made inside this network
 * namespace, from the kernel's socket tables (`/proc/net/tcp`, `tcp6`):
 * the entry whose local port is the client's port and whose remote port is
 * ours, and, when `addresses` are given, whose local and remote addresses
 * are the client's and ours. That covers loopback and the machine's (or
 * container's) own addresses. `null` when the peer is not in this network
 * namespace (e.g. connections through Docker's port publishing or a tunnel
 * from another host).
 */
export function loopbackPeer(
  clientPort: number,
  serverPort: number,
  addresses?: PeerAddresses,
  tables: () => string[] = () =>
    ['/proc/net/tcp', '/proc/net/tcp6'].map((file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return '';
      }
    }),
): PeerSocketEntry | null {
  const port = (address: string) => parseInt(address.split(':')[1] ?? '', 16);
  const host = (address: string) => tableAddress(address.split(':')[0] ?? '');
  for (const table of tables()) {
    for (const line of table.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 8) {
        continue;
      }
      const [, local, remote, state, , , , uid, , inode] = fields;
      // 01 = ESTABLISHED
      if (
        state === '01' &&
        port(local) === clientPort &&
        port(remote) === serverPort &&
        (!addresses ||
          (sameAddress(host(local), addresses.client) &&
            sameAddress(host(remote), addresses.server)))
      ) {
        return { uid: Number(uid), inode: Number(inode ?? 0) };
      }
    }
  }
  return null;
}

/** User ID of the client of a connection inside this network namespace, see {@link loopbackPeer}. */
export function loopbackPeerUid(
  clientPort: number,
  serverPort: number,
  addresses?: PeerAddresses,
  tables?: () => string[],
): number | null {
  return loopbackPeer(clientPort, serverPort, addresses, tables)?.uid ?? null;
}

export function isLoopback(address: string | undefined): boolean {
  return (
    !!address &&
    (address === '::1' ||
      address.startsWith('127.') ||
      address.startsWith('::ffff:127.'))
  );
}

/** An address of the socket tables (hex, host byte order per 32-bit word). */
function tableAddress(hex: string): string {
  if (hex.length === 8) {
    const bytes = Buffer.from(hex, 'hex');
    return [bytes[3], bytes[2], bytes[1], bytes[0]].join('.');
  }
  const bytes = Buffer.alloc(16);
  for (let word = 0; word < 4; word++) {
    Buffer.from(hex.slice(word * 8, word * 8 + 8), 'hex')
      .reverse()
      .copy(bytes, word * 4);
  }
  if (
    bytes.subarray(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  }
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(bytes.readUInt16BE(index).toString(16));
  }
  return groups.join(':');
}

/** Compares addresses, IPv4-mapped IPv6 and full IPv6 forms included. */
function sameAddress(table: string, socket: string): boolean {
  const normalize = (address: string) => {
    const lower = address.toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
    if (!lower.includes(':')) {
      return lower;
    }
    // Expand "::" so both forms compare equal.
    const [head, tail = ''] = lower.split('::');
    const left = head ? head.split(':') : [];
    const right = lower.includes('::') && tail ? tail.split(':') : [];
    const fill = lower.includes('::') ? 8 - left.length - right.length : 0;
    return [...left, ...Array(fill).fill('0'), ...right]
      .map((group) => parseInt(group, 16).toString(16))
      .join(':');
  };
  return normalize(table) === normalize(socket);
}
