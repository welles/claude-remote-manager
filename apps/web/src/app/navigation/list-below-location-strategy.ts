import {
  APP_BASE_HREF,
  DOCUMENT,
  PathLocationStrategy,
  PlatformLocation,
} from '@angular/common';
import { Injectable, inject } from '@angular/core';

/**
 * In the state of a history entry whose entry below is the session list:
 * the list's URL (`/`, or with its query such as `/?waiting=1`).
 */
const LIST_BELOW = 'crmListBelow';

type HistoryState = Record<string, unknown> | null | undefined;

/**
 * The session list, with or without a query or hash. URLs are the app's
 * paths: the base href is `/` (see `index.html`).
 */
function isList(url: string): boolean {
  return /^\/?(?:[?#]|$)/.test(url);
}

/** `''` and `/` are the same list. */
function normalized(url: string): string {
  return url === '' ? '/' : url;
}

function withQuery(url: string, queryParams: string): string {
  if (!queryParams) {
    return url;
  }
  return queryParams.startsWith('?')
    ? `${url}${queryParams}`
    : `${url}?${queryParams}`;
}

function marked(state: HistoryState, list: string): Record<string, unknown> {
  return { ...(state ?? {}), [LIST_BELOW]: list };
}

/**
 * Keeps the browser history flat, so that Back (also the swipe on phones)
 * always leads to the session list: below every other page there is
 * exactly one entry, the list.
 *
 * - From the list, pages are pushed; between other pages they replace the
 *   current entry.
 * - Going to the list below from another page goes back to it instead of
 *   adding a second list.
 * - Opened directly on another page (a link, a notification), the list is
 *   put below it at the first tap or key press: Chrome skips entries on
 *   Back from which a page added entries without user activation.
 */
@Injectable()
export class ListBelowLocationStrategy extends PathLocationStrategy {
  /** Whether this document has added a history entry itself. */
  private pushed = false;

  constructor() {
    super(
      inject(PlatformLocation),
      inject(APP_BASE_HREF, { optional: true }) ?? undefined,
    );
    this.putListBelowOnActivation();
  }

  override pushState(
    state: HistoryState,
    title: string,
    url: string,
    queryParams: string,
  ): void {
    const target = withQuery(url, queryParams);
    const current = this.path();
    const below = this.listBelow();
    if (isList(target)) {
      if (this.backToList(current, below, target)) {
        return;
      }
      this.pushed = true;
      super.pushState(state, title, url, queryParams);
      return;
    }
    if (isList(current)) {
      this.pushed = true;
      super.pushState(
        marked(state, normalized(current)),
        title,
        url,
        queryParams,
      );
    } else if (below !== null) {
      super.replaceState(marked(state, below), title, url, queryParams);
    } else {
      // What is below is unknown (an entry from before this strategy).
      this.pushed = true;
      super.pushState(state, title, url, queryParams);
    }
  }

  override replaceState(
    state: HistoryState,
    title: string,
    url: string,
    queryParams: string,
  ): void {
    const target = withQuery(url, queryParams);
    const below = this.listBelow();
    if (isList(target)) {
      // E.g. an unknown page that redirects to the list.
      if (!this.backToList(this.path(), below, target)) {
        super.replaceState(state, title, url, queryParams);
      }
      return;
    }
    super.replaceState(
      below !== null ? marked(state, below) : state,
      title,
      url,
      queryParams,
    );
  }

  /**
   * Goes back to the list below instead of adding the same list again.
   * The router already shows it; it ignores the popstate of the same URL.
   */
  private backToList(
    current: string,
    below: string | null,
    target: string,
  ): boolean {
    if (isList(current) || below !== normalized(target)) {
      return false;
    }
    this.historyGo(-1);
    return true;
  }

  private listBelow(): string | null {
    const list = (this.getState() as HistoryState)?.[LIST_BELOW];
    return typeof list === 'string' && isList(list) ? list : null;
  }

  private putListBelowOnActivation(): void {
    const view = inject(DOCUMENT).defaultView;
    if (!view || this.getState() != null || isList(this.path())) {
      // A reload keeps the state (and with it what is below).
      return;
    }
    // Touch activates at pointerup, mouse at pointerdown; both come before
    // the click that may navigate.
    const events = ['pointerdown', 'pointerup', 'keydown'] as const;
    const once = () => {
      if (view.navigator.userActivation?.hasBeenActive === false) {
        return; // E.g. Escape, or the mouse button still down.
      }
      for (const event of events) {
        view.removeEventListener(event, once, true);
      }
      this.putListBelow();
    };
    for (const event of events) {
      view.addEventListener(event, once, true);
    }
  }

  /** Puts the list below the current entry, if still the first one. */
  private putListBelow(): void {
    const path = this.path(true);
    if (this.pushed || isList(path) || this.listBelow() !== null) {
      return;
    }
    const state = this.getState() as HistoryState;
    super.replaceState(null, '', '/', '');
    this.pushed = true;
    super.pushState(marked(state, '/'), '', path, '');
  }
}
