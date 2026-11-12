import type {
  SessionStatus,
  UsageTotals,
} from '@claude-remote-manager/shared-types';

export const STATUS_LABELS: Record<SessionStatus, string> = {
  running: 'Running',
  waiting: 'Waiting',
  finished: 'Finished',
  failed: 'Failed',
};

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
