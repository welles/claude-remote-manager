import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  SearchHit,
  SearchMatch,
} from '@claude-remote-manager/shared-types';
import { SessionSearch, matchLabel } from './session-search';

describe('SessionSearch', () => {
  it('highlights matches inside a word without adding spaces', async () => {
    vi.useFakeTimers();
    try {
      await TestBed.configureTestingModule({
        imports: [SessionSearch],
        providers: [
          provideHttpClient(),
          provideHttpClientTesting(),
          provideRouter([]),
        ],
      }).compileComponents();
      const http = TestBed.inject(HttpTestingController);
      const fixture = TestBed.createComponent(SessionSearch);
      fixture.detectChanges();
      const input = fixture.nativeElement.querySelector(
        '[data-testid="search-input"]',
      ) as HTMLInputElement;
      input.value = 'rounding';
      input.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(300);
      http
        .expectOne((request) => request.url === '/api/search')
        .flush({
          query: 'rounding',
          truncated: false,
          hits: [
            {
              sessionId: 's1',
              title: 'Fix checkout',
              status: 'waiting',
              archivedAt: null,
              updatedAt: '2026-11-13T10:00:00Z',
              repositories: ['acme/webshop'],
              matchCount: 1,
              matches: [
                {
                  kind: 'branch',
                  snippet: 'claude/fix-checkout-rounding-7t3nwh',
                  highlights: [[20, 28]],
                  anchor: null,
                },
              ],
            },
          ],
        });
      fixture.detectChanges();
      const match = fixture.nativeElement.querySelector(
        '[data-testid="search-match"]',
      ) as HTMLElement;
      expect(match.querySelector('mark')?.textContent).toBe('rounding');
      expect(match.textContent).toBe(
        'Branchclaude/fix-checkout-rounding-7t3nwh',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('labels answers with the session’s agent', () => {
    const answer: SearchMatch = {
      kind: 'assistant',
      snippet: 'Done.',
      highlights: [],
      anchor: 'm1',
    };
    const hit = (engine?: SearchHit['engine']): SearchHit => ({
      sessionId: 's1',
      title: null,
      status: 'waiting',
      archivedAt: null,
      updatedAt: '2026-11-13T10:00:00Z',
      engine,
      repositories: [],
      matches: [answer],
      matchCount: 1,
    });
    expect(matchLabel(answer, hit('codex'))).toBe('Codex');
    expect(matchLabel(answer, hit('claude-code'))).toBe('Claude');
    // Older servers send no engine: Claude Code.
    expect(matchLabel(answer, hit())).toBe('Claude');
    expect(matchLabel({ ...answer, kind: 'user' }, hit('codex'))).toBe('You');
  });
});
