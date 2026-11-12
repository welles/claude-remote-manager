import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk';
import type { UsageTotals } from '@claude-remote-manager/shared-types';
import { EMPTY_USAGE } from './usage.repository';

const FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'costUsd',
] as const satisfies readonly (keyof UsageTotals)[];

function fromModelUsage(usage: ModelUsage): UsageTotals {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    costUsd: usage.costUSD,
  };
}

export function sumUsage(usages: Iterable<UsageTotals>): UsageTotals {
  const total = { ...EMPTY_USAGE };
  for (const usage of usages) {
    for (const field of FIELDS) {
      total[field] += usage[field];
    }
  }
  return total;
}

/**
 * Turns the cumulative per-model usage of Claude Code's result messages into
 * per-request amounts.
 *
 * In streaming-input mode every result message carries the running totals
 * of the `query()` call, and a resumed session starts from the totals saved
 * in its transcript. The tracker therefore starts from the usage already
 * recorded for the session and reports the difference on each result. If a
 * model's totals drop below that baseline (the transcript had no totals, or
 * the conversation was cleared), counting for that model starts over.
 */
export class UsageTracker {
  private readonly baseline: Map<string, UsageTotals>;

  constructor(recorded: Record<string, UsageTotals> = {}) {
    this.baseline = new Map(Object.entries(recorded));
  }

  /** Usage per model since the previous result; models without usage omitted. */
  consume(modelUsage: Record<string, ModelUsage>): Record<string, UsageTotals> {
    const deltas: Record<string, UsageTotals> = {};
    for (const [model, raw] of Object.entries(modelUsage)) {
      const current = fromModelUsage(raw);
      const previous = this.baseline.get(model) ?? EMPTY_USAGE;
      const restarted = FIELDS.some(
        (field) => current[field] < previous[field],
      );
      const base = restarted ? EMPTY_USAGE : previous;
      const delta = { ...EMPTY_USAGE };
      for (const field of FIELDS) {
        delta[field] = current[field] - base[field];
      }
      // Cost is a float; drop rounding noise.
      delta.costUsd = Math.round(delta.costUsd * 1e9) / 1e9;
      if (FIELDS.some((field) => delta[field] !== 0)) {
        deltas[model] = delta;
      }
      this.baseline.set(model, current);
    }
    return deltas;
  }
}
