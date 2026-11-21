import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { NeedsYouCount } from './pwa/needs-you';
import { WEBSOCKET_FACTORY } from './sessions/session-socket';
import { fakeWebSocketFactory } from './sessions/testing/fake-websocket';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: WEBSOCKET_FACTORY, useValue: fakeWebSocketFactory },
      ],
    }).compileComponents();
  });

  it('navigates to the four top-level pages, Sessions marked as current', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const items = [
      ...element.querySelectorAll('nav[aria-label="Main"] a[data-testid]'),
    ];
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      'Sessions',
      'Repos',
      'Usage',
      'Settings',
    ]);
    expect(items.map((item) => item.getAttribute('href'))).toEqual([
      '/',
      '/repositories',
      '/usage',
      '/settings',
    ]);
    expect(items[0].getAttribute('aria-current')).toBe('page');
    expect(items[1].hasAttribute('aria-current')).toBe(false);
  });

  it('shows how many sessions need the user on the Sessions item', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[data-testid="nav-needs-you"]')).toBeNull();
    TestBed.inject(NeedsYouCount).count.set(3);
    await fixture.whenStable();
    expect(
      element.querySelector('[data-testid="nav-needs-you"]')?.textContent,
    ).toContain('3');
  });
});
