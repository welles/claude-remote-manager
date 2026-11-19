import { TestBed } from '@angular/core/testing';
import { words } from '../testing/text';
import { AppToasts, TOAST_DURATION_MS, TOAST_LINE_MS, Toasts } from './toasts';

describe('Toasts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows results, lets info go by itself and keeps problems', async () => {
    const fixture = TestBed.createComponent(AppToasts);
    const toasts = TestBed.inject(Toasts);
    const element = fixture.nativeElement as HTMLElement;
    const shown = () =>
      [...element.querySelectorAll('[data-testid="toast"]')].map(words);

    toasts.show({ title: 'Cleaned up', lines: ['acme/app: removed'] });
    toasts.show({ title: 'The cleanup failed in part', kind: 'error' });
    fixture.detectChanges();
    expect(shown()).toEqual([
      'The cleanup failed in part',
      'Cleaned up acme/app: removed',
    ]);

    // Problems are alerts, the rest is announced politely.
    expect(words(element.querySelector('[role="alert"]'))).toBe(
      'The cleanup failed in part',
    );
    expect(words(element.querySelector('[role="status"]'))).toBe(
      'Cleaned up acme/app: removed',
    );

    // Stays a bit longer per line, and while the pointer is on it.
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    fixture.detectChanges();
    expect(shown()).toHaveLength(2);
    const info = element.querySelector('[role="status"] [data-testid="toast"]');
    info?.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(TOAST_DURATION_MS + TOAST_LINE_MS);
    fixture.detectChanges();
    expect(shown()).toHaveLength(2);
    info?.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(TOAST_DURATION_MS + TOAST_LINE_MS);
    fixture.detectChanges();
    expect(shown()).toEqual(['The cleanup failed in part']);

    (
      element.querySelector('[data-testid="toast-dismiss"]') as HTMLElement
    ).click();
    fixture.detectChanges();
    expect(shown()).toEqual([]);
  });
});
