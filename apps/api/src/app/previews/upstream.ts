import { connect as netConnect, type Socket } from 'node:net';
import type { ProcessIsolation } from '../common/process-isolation';
import {
  PROXY_TIMEOUTS,
  UpstreamError,
  type UpstreamConnector,
} from './preview-proxy';
import {
  acceptedSocketUid,
  listenersOn,
  loopbackReachable,
  readSocketTables,
  type SocketTables,
} from './socket-table';

/**
 * Which listening sockets a preview may forward to: only ports a process
 * of the session user listens on, on loopback (where the session's
 * processes listen; they share the API's network namespace), never the
 * API's own port.
 *
 * - `separate-users`: the listener must belong to the session user, so
 *   neither the API (its own port, anything it listens on) nor root
 *   services can be exposed. All sessions share that user, so which
 *   session's process listens cannot be told apart; a session can expose
 *   another session's dev server (it could reach it anyway).
 * - `single-user` (development): sessions run as the API's user; the
 *   listener must belong to that user, and the API's port is refused, but
 *   any other service of that user could be exposed.
 */
export interface PortPolicy {
  /** Ports that are never forwarded (the API's own). */
  forbiddenPorts(): number[];
  /** The owner every forwarded socket must have. */
  ownerUid: number;
  /** Who that is, for messages. */
  ownerName: string;
}

export function portPolicy(
  isolation: ProcessIsolation,
  forbiddenPorts: () => number[],
  apiUid = process.getuid?.() ?? -1,
): PortPolicy {
  return isolation.mode === 'separate-users'
    ? {
        forbiddenPorts,
        ownerUid: isolation.sessionUser.uid,
        ownerName: `the session user ${isolation.sessionUser.name}`,
      }
    : { forbiddenPorts, ownerUid: apiUid, ownerName: 'the session user' };
}

/** Whether a port can be forwarded now, and to which address. */
export type ListenerCheck =
  | { ok: true; address: string }
  | {
      ok: false;
      reason: 'forbidden' | 'nothing' | 'foreign' | 'not_loopback';
      message: string;
    };

export function checkListener(
  port: number,
  policy: PortPolicy,
  tables: SocketTables = readSocketTables,
): ListenerCheck {
  if (policy.forbiddenPorts().includes(port)) {
    return {
      ok: false,
      reason: 'forbidden',
      message: `Port ${port} is the session manager's own port and cannot be exposed`,
    };
  }
  const listeners = listenersOn(port, tables);
  if (listeners.length === 0) {
    return {
      ok: false,
      reason: 'nothing',
      message: `Nothing listens on port ${port}`,
    };
  }
  const own = listeners.filter((entry) => entry.uid === policy.ownerUid);
  if (own.length === 0) {
    return {
      ok: false,
      reason: 'foreign',
      message: `Port ${port} belongs to a process of another user (uid ${listeners[0].uid}), not to ${policy.ownerName}`,
    };
  }
  const reachable = own.filter((entry) =>
    loopbackReachable(entry.localAddress),
  );
  if (reachable.length === 0) {
    return {
      ok: false,
      reason: 'not_loopback',
      message: `Port ${port} listens on ${own.map((entry) => entry.localAddress).join(', ')} only; bind the server to 127.0.0.1, localhost or 0.0.0.0`,
    };
  }
  const v4 = reachable.find(
    (entry) =>
      entry.localAddress === '0.0.0.0' ||
      entry.localAddress.startsWith('127.') ||
      entry.localAddress.startsWith('::ffff:127.'),
  );
  if (v4) {
    return {
      ok: true,
      address:
        v4.localAddress === '0.0.0.0'
          ? '127.0.0.1'
          : v4.localAddress.replace(/^::ffff:/, ''),
    };
  }
  return { ok: true, address: '::1' };
}

/** How often and how long to look for the accepted socket in the tables. */
const OWNER_LOOKUPS = 10;
const OWNER_LOOKUP_DELAY_MS = 5;

/**
 * Connects to a preview's port and hands out the connection only after
 * checking that the socket that accepted it belongs to the policy's owner
 * (from the kernel's socket table): whatever listens when the connection is
 * made is checked, not what listened at some earlier point.
 */
export function upstreamConnector(
  port: number,
  policy: PortPolicy,
  tables: SocketTables = readSocketTables,
): UpstreamConnector {
  return (callback) => {
    let finished = false;
    const finish = (error: Error | null, socket?: Socket) => {
      if (!finished) {
        finished = true;
        callback(error, socket);
      }
    };
    const check = checkListener(port, policy, tables);
    if (!check.ok) {
      finish(
        check.reason === 'nothing'
          ? new UpstreamError('not_running', check.message)
          : new UpstreamError('refused', check.message),
      );
      return;
    }
    const socket = netConnect({ host: check.address, port });
    socket.setTimeout(PROXY_TIMEOUTS.connectMs, () =>
      socket.destroy(
        new UpstreamError('connect_timeout', 'No connection in time'),
      ),
    );
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => {
      socket.setTimeout(0);
      let attempts = 0;
      const verify = () => {
        if (socket.destroyed) {
          finish(new UpstreamError('broken', 'The connection closed'));
          return;
        }
        const uid =
          socket.localPort === undefined
            ? null
            : acceptedSocketUid(port, socket.localPort, tables);
        if (uid === policy.ownerUid) {
          finish(null, socket);
        } else if (uid === null && ++attempts < OWNER_LOOKUPS) {
          setTimeout(verify, OWNER_LOOKUP_DELAY_MS);
        } else {
          socket.destroy();
          finish(
            new UpstreamError(
              'refused',
              uid === null
                ? `The owner of the server on port ${port} could not be determined`
                : `Port ${port} is served by a process of another user (uid ${uid}), not by ${policy.ownerName}`,
            ),
          );
        }
      };
      verify();
    });
  };
}
