import { Injectable, signal } from '@angular/core';
import type { DiffLayout } from './diff-rows';

const STORAGE_KEY = 'crm.diffLayout';
/** Below this width side by side does not fit: unified by default. */
const NARROW = '(max-width: 899px)';

/**
 * The diff layout this viewer chose (kept in the browser), or the default:
 * unified on narrow screens such as phones, side by side otherwise.
 */
@Injectable({ providedIn: 'root' })
export class DiffLayoutPreference {
  readonly layout = signal<DiffLayout>(this.initial());

  set(layout: DiffLayout): void {
    this.layout.set(layout);
    try {
      localStorage.setItem(STORAGE_KEY, layout);
    } catch {
      // Not stored (private mode): only for this page.
    }
  }

  private initial(): DiffLayout {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'unified' || stored === 'split') {
        return stored;
      }
    } catch {
      // No storage: the default.
    }
    return typeof matchMedia === 'function' && matchMedia(NARROW).matches
      ? 'unified'
      : 'split';
  }
}
