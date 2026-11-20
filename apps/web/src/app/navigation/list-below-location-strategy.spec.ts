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
    // As in browsers: the URL and state change with the traversal, later.
    setTimeout(() => {
      this.index = Math.max(
        0,
        Math.min(this.entries.length - 1, this.index + delta),
      );
      const state = this.current.state;
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
  /** Starts on `url`, after `before` (entries of an earlier load). */
  const start = async (url: string, state: unknown = null, before?: string) => {
    TestBed.configureTestingModule({
      providers: [
        { provide: PlatformLocation, useClass: FakeHistory },
        { provide: LocationStrategy, useClass: ListBelowLocationStrategy },
        provideRouter([
          { path: '', component: Page },
          { path: 'sessions/**', component: Page },
          { path: '**', redirectTo: '' },
        ]),
      ],
    });
    const platform = TestBed.inject(PlatformLocation) as FakeHistory;
    if (before === undefined) {
      platform.replaceState(state, '', url);
    } else {
      platform.replaceState(null, '', before);
      platform.pushState(state, '', url);
    }
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
    expect(app.history()).toEqual(['/']);
  });

  it('goes back to the list below instead of adding another one', async () => {
    const app = await start('/');
    await app.go('/sessions/a');
    await app.go('/');
    expect(app.history()).toEqual(['/']);
    expect(app.router.url).toBe('/');
  });

  it('goes back to a list with a query only for the same list', async () => {
    const app = await start('/?waiting=1');
    await app.go('/sessions/a');
    await app.go('/?waiting=1');
    expect(app.history()).toEqual(['/?waiting=1']);
    await app.go('/sessions/a');
    // Another list (the back arrow leads to all sessions) is pushed.
    await app.go('/');
    expect(app.history()).toEqual(['/?waiting=1', '/sessions/a', '/']);
    expect(app.router.url).toBe('/');
  });

  it('goes back to the list when a page redirects to it', async () => {
    const app = await start('/');
    await app.go('/sessions/a');
    await app.router.navigateByUrl('/nowhere', { replaceUrl: true });
    await settle();
    expect(app.history()).toEqual(['/']);
    expect(app.router.url).toBe('/');
  });

  it('puts the list below a page opened directly, at the first tap', async () => {
    const app = await start('/sessions/a?mention=x');
    // Without user activation, Chrome would skip the list on Back.
    expect(app.history()).toEqual(['/sessions/a?mention=x']);
    window.dispatchEvent(new Event('pointerup'));
    expect(app.history()).toEqual(['/', '/sessions/a?mention=x']);
    window.dispatchEvent(new Event('pointerup'));
    expect(app.history()).toEqual(['/', '/sessions/a?mention=x']);
    await app.go('/sessions/b');
    expect(app.history()).toEqual(['/', '/sessions/b']);
    await app.back();
    expect(app.router.url).toBe('/');
  });

  it('keeps the list below on a reload', async () => {
    const app = await start(
      '/sessions/a',
      { navigationId: 3, crmListBelow: '/' },
      '/',
    );
    window.dispatchEvent(new Event('pointerup'));
    expect(app.history()).toEqual(['/', '/sessions/a']);
    await app.go('/sessions/b');
    expect(app.history()).toEqual(['/', '/sessions/b']);
    await app.go('/');
    expect(app.history()).toEqual(['/']);
    expect(app.router.url).toBe('/');
  });

  it('pushes pages over an entry from before', async () => {
    const app = await start('/sessions/a', { navigationId: 3 });
    window.dispatchEvent(new Event('pointerup'));
    expect(app.history()).toEqual(['/sessions/a']);
    await app.go('/sessions/b');
    expect(app.history()).toEqual(['/sessions/a', '/sessions/b']);
  });
});
