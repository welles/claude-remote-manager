import {
  pendingRequestLabel,
  type SessionDto,
  type SessionStatus,
  type UsageTotals,
} from '@claude-remote-manager/shared-types';
import { formatClock } from '../ui/dates';

export const STATUS_LABELS: Record<SessionStatus, string> = {
  preparing: 'Preparing',
  running: 'Running',
  waiting: 'Ready',
  finished: 'Finished',
  failed: 'Failed',
};

/**
 * Status label that says what a waiting session waits for: `Ready` for
 * the next message, `Background` while Claude's background tasks still
 * run (Claude goes on by itself), `Usage limit` while it waits for the
 * usage limit to reset.
 */
export function statusLabel(
  session: Pick<SessionDto, 'status' | 'waitingFor'>,
): string {
  if (session.status === 'waiting') {
    switch (session.waitingFor) {
      case 'permission':
        return 'Needs you';
      case 'setup':
        return 'Setup failed';
      case 'background':
        return 'Background';
      case 'limit':
        return 'Usage limit';
      default:
        return 'Ready';
    }
  }
  return STATUS_LABELS[session.status];
}

/**
 * What a session needs or waits for, as specific as known: `Approve
 * command`, `2 questions`, `Plan ready`, `Setup failed`, what Claude said
 * it waits for (`CI of PR #12`) or the CI of its pull requests the session
 * waits for (`CI of #12`), `2 background tasks`, when the session
 * continues after the usage limit (`Usage limit · 01:31`); else the status
 * label.
 */
export function needLabel(
  session: Pick<
    SessionDto,
    | 'status'
    | 'waitingFor'
    | 'pendingRequests'
    | 'backgroundTasks'
    | 'waitingReason'
    | 'limitResumesAt'
  >,
): string {
  if (
    session.status === 'waiting' &&
    session.waitingFor === 'limit' &&
    session.limitResumesAt
  ) {
    return `Usage limit · ${formatClock(session.limitResumesAt)}`;
  }
  if (
    session.status === 'waiting' &&
    session.waitingFor === 'background' &&
    session.waitingReason
  ) {
    return session.waitingReason;
  }
  if (
    session.status === 'waiting' &&
    session.waitingFor === 'background' &&
    session.backgroundTasks
  ) {
    return session.backgroundTasks === 1
      ? '1 background task'
      : `${session.backgroundTasks} background tasks`;
  }
  if (
    session.status === 'waiting' &&
    session.waitingFor === 'permission' &&
    session.pendingRequests
  ) {
    return pendingRequestLabel(session.pendingRequests);
  }
  return statusLabel(session);
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
