import { LocationStrategy, PlatformLocation } from '@angular/common';
import { Component, Injectable } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ListBelowLocationStrategy } from './list-below-location-strategy';

@Component({ template: '' })
class Page {}

interface Entry {
  url: URL;
  state: unknown;
}

/** The browser's history: popstate comes asynchronously, as in browsers. */
@Injectable()
class FakeHistory extends PlatformLocation {
  entries: Entry[] = [{ url: new URL('http://app/'), state: null }];
  index = 0;
  private readonly listeners = new Set<(event: PopStateEvent) => void>();

  private get current(): Entry {
    return this.entries[this.index];
  }
  get href() {
    return this.current.url.href;
  }
  get protocol() {
    return 'http:';
  }
  get hostname() {
    return 'app';
  }
  get port() {
    return '';
  }
  get pathname() {
    return this.current.url.pathname;
  }
  get search() {
    return this.current.url.search;
  }
  get hash() {
    return this.current.url.hash;
  }
  getBaseHrefFromDOM() {
    return '/';
  }
  getState() {
    return this.current.state;
  }
  onPopState(fn: (event: PopStateEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onHashChange() {
    return () => undefined;
  }
  pushState(state: unknown, _title: string, url: string) {
    this.entries.splice(this.index + 1);
    this.entries.push({ url: new URL(url, this.href), state: clone(state) });
    this.index++;
  }
  replaceState(state: unknown, _title: string, url: string) {
    this.entries[this.index] = {
      url: new URL(url, this.href),
      state: clone(state),
    };
  }
  forward() {
    this.historyGo(1);
  }
  back() {
    this.historyGo(-1);
  }
  override historyGo(delta = 0) {
    this.index = Math.max(
      0,
      Math.min(this.entries.length - 1, this.index + delta),
    );
    const state = this.current.state;
    setTimeout(() => {
      for (const fn of this.listeners) {
        fn({ type: 'popstate', state } as PopStateEvent);
      }
    });
  }
}

function clone(state: unknown): unknown {
  return state == null ? null : JSON.parse(JSON.stringify(state));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('ListBelowLocationStrategy', () => {
  const start = async (url: string, state: unknown = null) => {
    TestBed.configureTestingModule({
      providers: [
        { provide: PlatformLocation, useClass: FakeHistory },
        { provide: LocationStrategy, useClass: ListBelowLocationStrategy },
        provideRouter([{ path: '**', component: Page }]),
      ],
    });
    const platform = TestBed.inject(PlatformLocation) as FakeHistory;
    platform.replaceState(state, '', url);
    const router = TestBed.inject(Router);
    // As at the start of the app: also follows popstate from then on.
    router.initialNavigation();
    await settle();
    /** The history up to the current entry, as URLs. */
    const history = () =>
      platform.entries
        .slice(0, platform.index + 1)
        .map((entry) => `${entry.url.pathname}${entry.url.search}`);
    const go = async (target: string) => {
      await router.navigateByUrl(target);
      await settle();
    };
    const back = async () => {
      platform.back();
      await settle();
    };
    return { platform, router, history, go, back };
  };

  it('keeps one list below every other page', async () => {
    const app = await start('/');
    await app.go('/sessions/a');
    await app.go('/sessions/a/changes');
    await app.go('/sessions/b');
    expect(app.history()).toEqual(['/', '/sessions/b']);
    await app.back();
    expect(app.router.url).toBe('/');
  });

  it('goes back to the list instead of pushing another one', async () => {
    const app = await start('/?q=fix');
    await app.go('/sessions/a');
    await app.go('/');
    expect(app.history()).toEqual(['/?q=fix']);
    // The router follows the entry below, with its query.
    await new Promise((resolve) => setTimeout(resolve));
    expect(app.router.url).toBe('/?q=fix');
  });

  it('pushes a list with a query like any navigation', async () => {
    const app = await start('/');
    await app.go('/sessions/a');
    await app.go('/?q=fix');
    expect(app.history()).toEqual(['/', '/sessions/a', '/?q=fix']);
  });

  it('puts the list below a page opened directly', async () => {
    const app = await start('/sessions/a?mention=x');
    expect(app.history()).toEqual(['/', '/sessions/a?mention=x']);
    await app.go('/sessions/b');
    expect(app.history()).toEqual(['/', '/sessions/b']);
    await app.back();
    expect(app.router.url).toBe('/');
  });

  it('does not add another list on a reload', async () => {
    const app = await start('/sessions/a', { navigationId: 3 });
    expect(app.history()).toEqual(['/sessions/a']);
    // What is below is unknown: pages are pushed as before.
    await app.go('/sessions/b');
    expect(app.history()).toEqual(['/sessions/a', '/sessions/b']);
  });
});
