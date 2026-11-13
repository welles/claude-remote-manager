import {
  needsUser,
  pendingRequestLabel,
  type SessionDto,
  type SessionStatus,
  type UsageTotals,
} from '@claude-remote-manager/shared-types';

export const STATUS_LABELS: Record<SessionStatus, string> = {
  preparing: 'Preparing',
  running: 'Running',
  waiting: 'Waiting',
  finished: 'Finished',
  failed: 'Failed',
};

/** Status label that says what a waiting session waits for. */
export function statusLabel(
  session: Pick<SessionDto, 'status' | 'waitingFor'>,
): string {
  if (session.status === 'waiting') {
    switch (session.waitingFor) {
      case 'permission':
        return 'Needs you';
      case 'setup':
        return 'Setup failed';
      default:
        return 'Waiting';
    }
  }
  return STATUS_LABELS[session.status];
}

/**
 * What a session needs, as specific as known: `Approve command`,
 * `2 questions`, `Plan ready`, `Setup failed`; else the status label.
 */
export function needLabel(
  session: Pick<SessionDto, 'status' | 'waitingFor' | 'pendingRequests'>,
): string {
  if (
    session.status === 'waiting' &&
    session.waitingFor === 'permission' &&
    session.pendingRequests
  ) {
    return pendingRequestLabel(session.pendingRequests);
  }
  return statusLabel(session);
}

/**
 * CSS class of the status badge. `status-permission` stands out: every
 * session blocked on the user (see `needsUser`), including a failed setup
 * script that holds the first message back.
 */
export function statusClass(
  session: Pick<SessionDto, 'status' | 'waitingFor'>,
): string {
  return needsUser(session) ? 'status-permission' : `status-${session.status}`;
}

/** Compact token count, e.g. `950`, `12.3k`, `1.2M`. */
export function formatTokens(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  if (value < 1_000_000) {
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Cost in USD; small amounts with more digits. */
export function formatCost(usd: number): string {
  return `$${usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

export function totalTokens(usage: UsageTotals): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens
  );
}

/** Size in bytes, e.g. `512 B`, `3.4 MB`. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
