import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { WEBSOCKET_FACTORY } from '../sessions/session-socket';
import { SessionSocket } from '../sessions/session-socket';
import {
  FakeWebSocket,
  fakeWebSocketFactory,
} from '../sessions/testing/fake-websocket';
import { IDLE_MS, PresenceReporter, sessionOfUrl } from './presence-reporter';

@Component({ template: '' })
class Empty {}

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('PresenceReporter', () => {
  let now: number;
  let presence: PresenceReporter;
  let focused: boolean;

  beforeEach(async () => {
    FakeWebSocket.instances = [];
    focused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'sessions/:id', component: Empty },
          { path: '**', component: Empty },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: WEBSOCKET_FACTORY, useValue: fakeWebSocketFactory },
      ],
    });
    now = 1_000_000;
    presence = TestBed.inject(PresenceReporter);
    presence.now = () => now;
    TestBed.inject(SessionSocket).connect();
    FakeWebSocket.last.open();
  });
  afterEach(() => vi.restoreAllMocks());

  const frames = () =>
    FakeWebSocket.last.sent.filter(
      (frame) => (frame as { type: string }).type === 'presence',
    );

  it('reports the session in view while the user is active', async () => {
    presence.start();
    await TestBed.inject(Router).navigateByUrl(`/sessions/${SESSION}`);
    expect(frames().at(-1)).toEqual({
      type: 'presence',
      sessionId: SESSION,
      active: true,
    });
    // Unfocused (another window, or the phone locked).
    focused = false;
    window.dispatchEvent(new Event('blur'));
    expect(frames().at(-1)).toEqual({
      type: 'presence',
      sessionId: SESSION,
      active: false,
    });
    focused = true;
    window.dispatchEvent(new Event('focus'));
    expect(frames().at(-1)).toMatchObject({ active: true });
    // Idle for long: away, until the next input.
    now += IDLE_MS + 1;
    presence.report(true);
    expect(frames().at(-1)).toMatchObject({ active: false });
    window.dispatchEvent(new Event('pointerdown'));
    expect(frames().at(-1)).toMatchObject({ active: true });
    // Other pages show no session.
    await TestBed.inject(Router).navigateByUrl('/settings');
    expect(frames().at(-1)).toEqual({
      type: 'presence',
      sessionId: null,
      active: false,
    });
  });

  it('knows which URLs show a session', () => {
    expect(sessionOfUrl(`/sessions/${SESSION}`)).toBe(SESSION);
    expect(sessionOfUrl(`/sessions/${SESSION}?x=1`)).toBe(SESSION);
    expect(sessionOfUrl(`/sessions/${SESSION}/changes`)).toBeNull();
    expect(sessionOfUrl('/')).toBeNull();
  });
});
