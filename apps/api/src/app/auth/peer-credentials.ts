import { readFileSync } from 'node:fs';

/**
 * User ID of the process on the other end of a TCP connection over
 * loopback, from the kernel's socket tables (`/proc/net/tcp`, `tcp6`): the
 * client socket is the entry whose local port is the client's port and
 * whose remote port is ours. `null` when the peer is not in this network
 * namespace (e.g. connections through Docker's port publishing).
 */
export function loopbackPeerUid(
  clientPort: number,
  serverPort: number,
  tables: () => string[] = () =>
    ['/proc/net/tcp', '/proc/net/tcp6'].map((file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return '';
      }
    }),
): number | null {
  const port = (address: string) => parseInt(address.split(':')[1] ?? '', 16);
  for (const table of tables()) {
    for (const line of table.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 8) {
        continue;
      }
      const [, local, remote, state, , , , uid] = fields;
      // 01 = ESTABLISHED
      if (
        state === '01' &&
        port(local) === clientPort &&
        port(remote) === serverPort
      ) {
        return Number(uid);
      }
    }
  }
  return null;
}

export function isLoopback(address: string | undefined): boolean {
  return (
    !!address &&
    (address === '::1' ||
      address.startsWith('127.') ||
      address.startsWith('::ffff:127.'))
  );
}
