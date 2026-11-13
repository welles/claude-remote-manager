import type {
  UsageSeries,
  UsageStatistics,
  UsageTotals,
} from '@claude-remote-manager/shared-types';
import { dateFormat } from '../ui/dates';

/** What the chart shows. */
export type UsageMeasure = 'cost' | 'tokens';

/** Series drawn with their own colour; the rest becomes "Other". */
export const MAX_SERIES = 6;

export function measure(totals: UsageTotals, kind: UsageMeasure): number {
  return kind === 'cost'
    ? totals.costUsd
    : totals.inputTokens +
        totals.outputTokens +
        totals.cacheCreationInputTokens +
        totals.cacheReadInputTokens;
}

/** A series as drawn: `slot` 1-6 is its colour, 0 is "Other". */
export interface ChartSeries {
  key: string;
  label: string;
  slot: number;
  total: number;
  values: number[];
  series: UsageSeries | null;
}

/**
 * The series to draw: the {@link MAX_SERIES} largest by the measure, in
 * that order (colours follow the series, assigned in order), the rest
 * summed as "Other".
 */
export function chartSeries(
  statistics: UsageStatistics,
  kind: UsageMeasure,
): ChartSeries[] {
  const ranked = [...statistics.series].sort(
    (a, b) => measure(b.totals, kind) - measure(a.totals, kind),
  );
  const shown = ranked.slice(0, MAX_SERIES).map(
    (series, index): ChartSeries => ({
      key: series.key,
      label: series.label,
      slot: index + 1,
      total: measure(series.totals, kind),
      values: series.values.map((value) => measure(value, kind)),
      series,
    }),
  );
  const rest = ranked.slice(MAX_SERIES);
  if (rest.length > 0) {
    shown.push({
      key: '__other__',
      label: `Other (${rest.length})`,
      slot: 0,
      total: rest.reduce(
        (sum, series) => sum + measure(series.totals, kind),
        0,
      ),
      values: statistics.buckets.map((_, index) =>
        rest.reduce(
          (sum, series) => sum + measure(series.values[index], kind),
          0,
        ),
      ),
      series: null,
    });
  }
  return shown;
}

/** A round upper bound for the axis and 4 evenly spaced ticks. */
export function axisTicks(max: number): number[] {
  if (max <= 0) {
    return [0];
  }
  const rough = max / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10]
      .map((factor) => factor * power)
      .find((s) => s >= rough) ?? rough;
  return [0, 1, 2, 3, 4].map((index) => index * step);
}

/** Bucket label: `13 Nov`, `9 Nov` (week start) or `Nov 2026`. */
export function bucketLabel(
  bucket: string,
  granularity: UsageStatistics['granularity'],
): string {
  const date = new Date(`${bucket}T00:00:00Z`);
  return granularity === 'month'
    ? dateFormat({ month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
        date,
      )
    : dateFormat({ day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
        date,
      );
}
