import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  UsageSeries,
  UsageStatistics,
  UsageTotals,
} from '@claude-remote-manager/shared-types';
import { words } from '../testing/text';
import { WorkspacePage } from '../workspace/workspace-page';
import { axisTicks, chartSeries } from './usage-chart';
import { UsagePage } from './usage-page';

const totals = (cost: number, tokens = 100): UsageTotals => ({
  inputTokens: tokens,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  costUsd: cost,
});

const series = (key: string, values: number[]): UsageSeries => ({
  key,
  label: key,
  state: null,
  sessionId: null,
  totals: totals(values.reduce((a, b) => a + b, 0)),
  values: values.map((value) => totals(value)),
});

const statistics = (list: UsageSeries[]): UsageStatistics => ({
  granularity: 'day',
  groupBy: 'model',
  timeZone: 'Europe/Berlin',
  from: '2026-11-12',
  to: '2026-11-13',
  buckets: ['2026-11-12', '2026-11-13'],
  series: list,
  totals: totals(
    list.reduce((sum, entry) => sum + entry.totals.costUsd, 0),
    200,
  ),
  requests: 3,
});

describe('usage chart', () => {
  it('draws the six largest series and folds the rest into Other', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((key, index) =>
      series(key, [index + 1, 0]),
    );
    const drawn = chartSeries(statistics(list), 'cost');
    expect(drawn.map((entry) => [entry.label, entry.slot])).toEqual([
      ['h', 1],
      ['g', 2],
      ['f', 3],
      ['e', 4],
      ['d', 5],
      ['c', 6],
      ['Other (2)', 0],
    ]);
    expect(drawn.at(-1)?.values).toEqual([3, 0]);
  });

  it('picks round axis ticks', () => {
    expect(axisTicks(0)).toEqual([0]);
    expect(axisTicks(0.9)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(axisTicks(37)).toEqual([0, 10, 20, 30, 40]);
  });
});

describe('UsagePage and WorkspacePage', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [UsagePage, WorkspacePage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('loads the statistics in the browser’s time zone and draws bars, legend and table', async () => {
    const fixture = TestBed.createComponent(UsagePage);
    fixture.detectChanges();
    const request = http.expectOne((req) => req.url === '/api/usage');
    expect(request.request.params.get('granularity')).toBe('day');
    expect(request.request.params.get('groupBy')).toBe('session');
    expect(request.request.params.get('tz')).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    request.flush(
      statistics([series('claude-haiku', [0.5, 0.25]), series('opus', [0, 2])]),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const text = (id: string) =>
      words(element.querySelector(`[data-testid="${id}"]`));
    expect(text('cost-note')).toContain('theoretical');
    expect(text('total-cost')).toContain('$2.75');
    expect(element.querySelectorAll('[data-testid="usage-bar"]')).toHaveLength(
      2,
    );
    expect(element.querySelectorAll('rect.segment')).toHaveLength(3);
    expect(text('usage-legend')).toBe('opus $2.00 claude-haiku $0.75');
    expect(text('usage-table')).toContain('claude-haiku 100 0 0 0 $0.75');

    (element.querySelector('[data-testid="by-month"]') as HTMLElement).click();
    const monthly = http.expectOne((req) => req.url === '/api/usage');
    expect(monthly.request.params.get('granularity')).toBe('month');
    monthly.flush(statistics([]));
    fixture.detectChanges();
    expect(text('usage-empty')).toBe('No usage in this period.');
  });

  it('lists leftovers and removes one only after the loss was accepted', async () => {
    const fixture = TestBed.createComponent(WorkspacePage);
    fixture.detectChanges();
    const orphan = {
      path: '/workspace/sessions/gone/acme/app',
      kind: 'clone' as const,
      branch: 'claude/gone',
      loss: {
        files: ['draft.txt'],
        fileCount: 1,
        unpushedCommits: [],
        unpushedCount: 0,
        stashes: 0,
        bytes: 1000,
        clean: false,
      },
      error: null,
    };
    http
      .expectOne('/api/workspace/orphans')
      .flush({ orphans: [orphan], missing: [] });
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const click = async (selector: string) => {
      (element.querySelector(selector) as HTMLElement).click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    expect(words(element.querySelector('[data-testid="orphan"]'))).toContain(
      'draft.txt',
    );
    await click('[data-testid="orphan-remove"]');
    const confirm = element.querySelector(
      '[data-testid="orphan-remove-confirm"]',
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await click('[data-testid="orphan-accept-loss"] input');
    expect(confirm.disabled).toBe(false);
    await click('[data-testid="orphan-remove-confirm"]');
    const request = http.expectOne('/api/workspace/orphans/remove');
    expect(request.request.body).toEqual({
      path: orphan.path,
      confirm: true,
      acceptLoss: true,
    });
    request.flush({ orphans: [], missing: [] });
    fixture.detectChanges();
    expect(element.querySelector('[data-testid="no-orphans"]')).not.toBeNull();
  });
});
