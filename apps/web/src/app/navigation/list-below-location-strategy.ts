import {
  APP_BASE_HREF,
  PathLocationStrategy,
  PlatformLocation,
} from '@angular/common';
import { Injectable, inject } from '@angular/core';

/**
 * Marks a history entry whose entry below is the session list (`/`, with
 * or without a query).
 */
const LIST_BELOW = 'crmListBelow';

type HistoryState = Record<string, unknown> | null | undefined;

/** The session list, with or without a query or hash. */
function isList(url: string): boolean {
  return /^\/?(?:[?#]|$)/.test(url);
}

function withQuery(url: string, queryParams: string): string {
  if (!queryParams) {
    return url;
  }
  return queryParams.startsWith('?')
    ? `${url}${queryParams}`
    : `${url}?${queryParams}`;
}

function marked(state: HistoryState): Record<string, unknown> {
  return { ...(state ?? {}), [LIST_BELOW]: true };
}

/**
 * Keeps the browser history flat, so that Back (also the swipe on phones)
 * always leads to the session list: below every other page there is
 * exactly one entry, the list.
 *
 * - From the list, pages are pushed; between other pages they replace the
 *   current entry.
 * - Going to the plain list from another page goes back to the entry below
 *   instead of pushing a second list.
 * - Opened directly on another page (a link, a notification), the list is
 *   put below it first.
 */
@Injectable()
export class ListBelowLocationStrategy extends PathLocationStrategy {
  constructor() {
    super(
      inject(PlatformLocation),
      inject(APP_BASE_HREF, { optional: true }) ?? undefined,
    );
    this.putListBelow();
  }

  override pushState(
    state: HistoryState,
    title: string,
    url: string,
    queryParams: string,
  ): void {
    const target = withQuery(url, queryParams);
    const onList = isList(this.path());
    const listBelow = this.listBelow();
    if (isList(target)) {
      if (!onList && listBelow && (target === '/' || target === '')) {
        // The router already shows the list; the popstate of the same URL
        // is ignored by it.
        this.historyGo(-1);
        return;
      }
      super.pushState(state, title, url, queryParams);
      return;
    }
    if (onList) {
      super.pushState(marked(state), title, url, queryParams);
    } else if (listBelow) {
      super.replaceState(marked(state), title, url, queryParams);
    } else {
      // An entry from before this strategy: what is below is unknown.
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
    super.replaceState(
      !isList(target) && this.listBelow() ? marked(state) : state,
      title,
      url,
      queryParams,
    );
  }

  private listBelow(): boolean {
    const state = this.getState() as HistoryState;
    return state?.[LIST_BELOW] === true;
  }

  /**
   * A fresh entry (no state yet) on another page than the list gets the
   * list below it. A reload keeps the state, so it does not add another.
   */
  private putListBelow(): void {
    const path = this.path(true);
    if (isList(path) || this.getState() != null) {
      return;
    }
    super.replaceState(null, '', '/', '');
    super.pushState(marked(null), '', path, '');
  }
}
