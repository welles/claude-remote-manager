import { HttpClient } from '@angular/common/http';
import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import type {
  UsageGranularity,
  UsageGroupBy,
  UsageStatistics,
} from '@claude-remote-manager/shared-types';
import { formatCost, formatTokens, totalTokens } from '../sessions/format';
import { dateFormat } from '../ui/dates';
import {
  axisTicks,
  bucketLabel,
  chartSeries,
  type UsageMeasure,
} from './usage-chart';
import { AppPageBar } from '../ui/page-bar';

/**
 * Geometry of the chart's SVG; the width follows the element's (one user
 * unit is one pixel, so labels keep their size on phones and desktops).
 */
const DEFAULT_WIDTH = 640;
const HEIGHT = 240;
const PLOT = { left: 56, right: 8, top: 8, bottom: 28 };

/** The browser's time zone, which the day boundaries follow. */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Usage and theoretical API cost over time: by day, week or month, split
 * by session, repository or model, as a stacked bar chart (plain SVG)
 * with a legend and a table. Lazy-loaded.
 */
@Component({
  selector: 'app-usage-page',
  host: { class: 'app-page [--app-page-max:1320px]' },
  imports: [AppPageBar, MatProgressBarModule, RouterLink],
  templateUrl: './usage-page.html',
})
export class UsagePage implements OnInit {
  private readonly http = inject(HttpClient);

  protected readonly formatCost = formatCost;
  protected readonly formatTokens = formatTokens;
  protected readonly totalTokens = totalTokens;
  protected readonly width = signal(DEFAULT_WIDTH);
  protected readonly height = HEIGHT;
  protected readonly plot = PLOT;
  protected readonly timeZone = browserTimeZone();

  protected readonly granularity = signal<UsageGranularity>('day');
  protected readonly groupBy = signal<UsageGroupBy>('session');
  protected readonly measure = signal<UsageMeasure>('cost');
  protected readonly statistics = signal<UsageStatistics | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Bucket under the pointer (or focused), for the tooltip. */
  protected readonly hovered = signal<number | null>(null);

  protected readonly series = computed(() => {
    const statistics = this.statistics();
    return statistics ? chartSeries(statistics, this.measure()) : [];
  });
  /** Stacked bars per bucket: segments bottom-up with their geometry. */
  protected readonly chart = computed(() => {
    const statistics = this.statistics();
    const series = this.series();
    if (!statistics) {
      return null;
    }
    const count = statistics.buckets.length;
    const sums = statistics.buckets.map((_, index) =>
      series.reduce((sum, entry) => sum + entry.values[index], 0),
    );
    const ticks = axisTicks(Math.max(0, ...sums));
    const top = ticks.at(-1) || 1;
    const plotWidth = this.width() - PLOT.left - PLOT.right;
    const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
    const slot = plotWidth / Math.max(1, count);
    const barWidth = Math.max(2, Math.min(32, slot * 0.7));
    const y = (value: number) => PLOT.top + plotHeight * (1 - value / top);
    const labelEvery = Math.ceil(
      count / Math.max(2, Math.floor(plotWidth / 70)),
    );
    const bars = statistics.buckets.map((bucket, index) => {
      const x = PLOT.left + slot * index + (slot - barWidth) / 2;
      let base = 0;
      const segments = series
        .filter((entry) => entry.values[index] > 0)
        .map((entry) => {
          const from = base;
          base += entry.values[index];
          const yTop = y(base);
          // A 2px gap between stacked segments.
          const height = Math.max(0, y(from) - yTop - (from > 0 ? 2 : 0));
          return { slot: entry.slot, key: entry.key, y: yTop, height };
        });
      return {
        index,
        bucket,
        x,
        label:
          index % labelEvery === 0
            ? bucketLabel(bucket, statistics.granularity)
            : null,
        total: sums[index],
        segments,
      };
    });
    return {
      bars,
      barWidth,
      slot,
      ticks: ticks.map((value) => ({ value, y: y(value) })),
      baseline: y(0),
    };
  });
  protected readonly tooltip = computed(() => {
    const index = this.hovered();
    const statistics = this.statistics();
    if (index === null || !statistics) {
      return null;
    }
    return {
      label: bucketLabel(statistics.buckets[index], statistics.granularity),
      bucket: statistics.buckets[index],
      rows: this.series()
        .filter((entry) => entry.values[index] > 0)
        .reverse()
        .map((entry) => ({
          label: entry.label,
          slot: entry.slot,
          value: this.format(entry.values[index]),
        })),
      total: this.format(
        this.series().reduce((sum, entry) => sum + entry.values[index], 0),
      ),
    };
  });

  ngOnInit(): void {
    this.load();
  }

  constructor() {
    const host = inject(ElementRef).nativeElement as HTMLElement;
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => {
        const width = Math.round(host.clientWidth);
        if (width > 0) {
          this.width.set(Math.max(280, width));
        }
      });
      observer.observe(host);
      inject(DestroyRef).onDestroy(() => observer.disconnect());
    }
  }

  protected setGranularity(value: UsageGranularity): void {
    this.granularity.set(value);
    this.load();
  }

  protected setGroupBy(value: UsageGroupBy): void {
    this.groupBy.set(value);
    this.load();
  }

  protected format(value: number): string {
    return this.measure() === 'cost' ? formatCost(value) : formatTokens(value);
  }

  protected axisLabel(value: number): string {
    return this.measure() === 'cost'
      ? `$${value < 1 && value > 0 ? value.toFixed(2) : Math.round(value * 100) / 100}`
      : formatTokens(value);
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.hovered.set(null);
    this.http
      .get<UsageStatistics>('/api/usage', {
        params: {
          granularity: this.granularity(),
          groupBy: this.groupBy(),
          tz: this.timeZone,
        },
      })
      .subscribe({
        next: (statistics) => {
          this.loading.set(false);
          this.statistics.set(statistics);
        },
        error: () => {
          this.loading.set(false);
          this.error.set('The usage could not be loaded.');
        },
      });
  }

  protected periodLabel(statistics: UsageStatistics): string {
    const from = new Date(`${statistics.from}T00:00:00Z`);
    const to = new Date(`${statistics.to}T00:00:00Z`);
    const format = (date: Date) =>
      dateFormat({
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(date);
    return `${format(from)} – ${format(to)}`;
  }
}
