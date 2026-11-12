import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk';
import { sumUsage, UsageTracker } from './usage-tracker';

const modelUsage = (
  input: number,
  output: number,
  cacheWrite: number,
  cacheRead: number,
  cost: number,
): ModelUsage => ({
  inputTokens: input,
  outputTokens: output,
  cacheCreationInputTokens: cacheWrite,
  cacheReadInputTokens: cacheRead,
  costUSD: cost,
  webSearchRequests: 0,
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
});

const totals = (
  input: number,
  output: number,
  cacheWrite: number,
  cacheRead: number,
  cost: number,
) => ({
  inputTokens: input,
  outputTokens: output,
  cacheCreationInputTokens: cacheWrite,
  cacheReadInputTokens: cacheRead,
  costUsd: cost,
});

describe('UsageTracker', () => {
  it('reports the difference between cumulative results', () => {
    const tracker = new UsageTracker();

    expect(tracker.consume({ haiku: modelUsage(10, 5, 100, 0, 0.01) })).toEqual(
      {
        haiku: totals(10, 5, 100, 0, 0.01),
      },
    );
    expect(
      tracker.consume({
        haiku: modelUsage(13, 9, 100, 200, 0.03),
        opus: modelUsage(1, 1, 1, 1, 0.5),
      }),
    ).toEqual({
      haiku: totals(3, 4, 0, 200, 0.02),
      opus: totals(1, 1, 1, 1, 0.5),
    });
  });

  it('omits models whose usage did not change', () => {
    const tracker = new UsageTracker();
    tracker.consume({ haiku: modelUsage(1, 1, 1, 1, 0.1) });
    expect(tracker.consume({ haiku: modelUsage(1, 1, 1, 1, 0.1) })).toEqual({});
  });

  it('continues from recorded usage when a resumed session restores totals', () => {
    const tracker = new UsageTracker({ haiku: totals(10, 5, 100, 0, 0.01) });
    expect(
      tracker.consume({ haiku: modelUsage(12, 8, 100, 50, 0.015) }),
    ).toEqual({
      haiku: totals(2, 3, 0, 50, 0.005),
    });
  });

  it('starts over when the totals were not restored', () => {
    const tracker = new UsageTracker({ haiku: totals(10, 5, 100, 0, 0.01) });
    expect(tracker.consume({ haiku: modelUsage(2, 3, 0, 50, 0.005) })).toEqual({
      haiku: totals(2, 3, 0, 50, 0.005),
    });
    expect(tracker.consume({ haiku: modelUsage(4, 3, 0, 50, 0.006) })).toEqual({
      haiku: totals(2, 0, 0, 0, 0.001),
    });
  });

  it('removes floating point noise from costs', () => {
    const tracker = new UsageTracker();
    tracker.consume({ m: modelUsage(1, 0, 0, 0, 0.1) });
    expect(tracker.consume({ m: modelUsage(2, 0, 0, 0, 0.3) }).m.costUsd).toBe(
      0.2,
    );
  });
});

describe('sumUsage', () => {
  it('adds all fields', () => {
    expect(
      sumUsage([totals(1, 2, 3, 4, 0.5), totals(1, 1, 1, 1, 0.25)]),
    ).toEqual(totals(2, 3, 4, 5, 0.75));
    expect(sumUsage([])).toEqual(totals(0, 0, 0, 0, 0));
  });
});
