import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
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

  it('shows the application name in the toolbar', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('mat-toolbar')?.textContent).toContain(
      'Claude Remote Manager',
    );
    // The account's limits are in the header (unknown until loaded).
    TestBed.inject(HttpTestingController).expectOne('/api/limits');
    expect(
      element.querySelector('[data-testid="limits"]')?.textContent,
    ).toContain('Limits ?');
  });
});
