import { TestBed } from '@angular/core/testing';
import { words } from '../testing/text';
import { AppToasts, TOAST_DURATION_MS, Toasts } from './toasts';

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
      'Cleaned up acme/app: removed',
      'The cleanup failed in part',
    ]);

    vi.advanceTimersByTime(TOAST_DURATION_MS);
    fixture.detectChanges();
    expect(shown()).toEqual(['The cleanup failed in part']);

    (
      element.querySelector('[data-testid="toast-dismiss"]') as HTMLElement
    ).click();
    fixture.detectChanges();
    expect(shown()).toEqual([]);
  });
});
