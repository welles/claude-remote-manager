import { DestroyRef, inject, signal, type Signal } from '@angular/core';

/**
 * Whether a media query matches, as a signal (false where `matchMedia` is
 * missing, as in tests). Call in an injection context.
 */
export function mediaQuery(query: string): Signal<boolean> {
  const list = typeof matchMedia === 'function' ? matchMedia(query) : null;
  const matches = signal(list?.matches ?? false);
  if (list) {
    const onChange = (event: MediaQueryListEvent) => matches.set(event.matches);
    list.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() =>
      list.removeEventListener('change', onChange),
    );
  }
  return matches.asReadonly();
}

/** Widths of the desktop layouts (see the shell's rail at 840 px). */
export const WIDE_LIST = '(min-width: 1100px)';
export const WIDE_PANEL = '(min-width: 1360px)';
