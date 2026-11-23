import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { words } from '../testing/text';
import { ReviewCard, type ReviewItem } from './review-card';

const item = (overrides: Partial<ReviewItem> = {}): ReviewItem => ({
  kind: 'review',
  key: 'review:r1',
  reviewId: 'r1',
  trigger: 'manual',
  model: 'claude-fable-5-2',
  effort: 'high',
  fileCount: 3,
  repositories: ['alice/app'],
  outcome: null,
  summary: null,
  findings: [],
  error: null,
  durationMs: null,
  usage: null,
  messageId: null,
  ...overrides,
});

describe('ReviewCard', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ReviewCard],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  const render = (review: ReviewItem, runningId: string | null = null) => {
    const fixture = TestBed.createComponent(ReviewCard);
    fixture.componentRef.setInput('item', review);
    fixture.componentRef.setInput('sessionId', 's1');
    fixture.componentRef.setInput('runningId', runningId);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const text = (testId: string) =>
      [...element.querySelectorAll(`[data-testid="${testId}"]`)].map((node) =>
        words(node),
      );
    return { fixture, element, text };
  };

  it('shows a running review with Cancel', () => {
    const { element, text } = render(item(), 'r1');
    expect(text('review-state')).toEqual(['running…']);
    expect(text('review-meta')[0]).toContain(
      'claude-fable-5-2 · effort High · 3 files',
    );
    (
      element.querySelector('[data-testid="review-cancel"]') as HTMLElement
    ).click();
    const request = http.expectOne('/api/sessions/s1/review');
    expect(request.request.method).toBe('DELETE');
    request.flush(null);
  });

  it('shows the findings and that they went to Claude', () => {
    const { text } = render(
      item({
        outcome: 'finished',
        summary: 'Two issues.',
        findings: [
          {
            severity: 'high',
            repository: 'alice/app',
            file: 'src/a.ts',
            line: 4,
            title: 'Off by one',
            detail: 'The loop **skips** the last item.',
          },
          {
            severity: 'low',
            repository: null,
            file: null,
            line: null,
            title: 'Name',
            detail: 'Rename it.',
          },
        ],
        durationMs: 61_000,
        messageId: 'm1',
      }),
    );
    expect(text('review-state')).toEqual(['2 findings']);
    expect(text('review-summary')).toEqual(['Two issues.']);
    expect(text('review-finding')).toEqual([
      'High Off by one · src/a.ts:4 The loop skips the last item.',
      'Low Name Rename it.',
    ]);
    expect(text('review-sent')).toEqual([
      'The findings went to Claude to fix.',
    ]);
    expect(text('review-cancel')).toEqual([]);
  });

  it('says when a review failed or was cut off', () => {
    expect(
      render(item({ outcome: 'failed', error: 'No answer' })).text(
        'review-error',
      ),
    ).toEqual(['No answer']);
    expect(render(item()).text('review-state')).toEqual(['interrupted']);
  });
});
