import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { PRESENCE_INTERVAL_MS } from '@claude-remote-manager/shared-types';
import { SessionSocket } from '../sessions/session-socket';

/** Without input for this long the user counts as away. */
export const IDLE_MS = 5 * 60_000;

const INPUT_EVENTS = [
  'pointerdown',
  'keydown',
  'wheel',
  'touchstart',
  'scroll',
];

/** The session a URL shows (`/sessions/<id>`), not its changes page. */
export function sessionOfUrl(url: string): string | null {
  return /^\/sessions\/([0-9a-f-]{36})(?:[?#]|$)/i.exec(url)?.[1] ?? null;
}

/**
 * Tells the API which session this window shows to an active user, so that
 * it sends no notification about it (`presence` frames). Active means: the
 * page is visible and focused and was used within {@link IDLE_MS}. The
 * frame is repeated while active; a frozen page (a phone put away) stops
 * repeating it and the API stops counting it.
 */
@Injectable({ providedIn: 'root' })
export class PresenceReporter {
  private readonly socket = inject(SessionSocket);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private sessionId: string | null = null;
  private lastInput = Date.now();
  private sent = '';
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Clock, replaceable in tests. */
  now: () => number = () => Date.now();

  start(): void {
    const window = this.document.defaultView;
    if (!window || this.timer) {
      return;
    }
    this.lastInput = this.now();
    this.sessionId = sessionOfUrl(this.router.url);
    const subscription = this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe((event) => {
        this.sessionId = sessionOfUrl(event.urlAfterRedirects);
        this.report();
      });
    const onInput = () => {
      const wasIdle = !this.active();
      this.lastInput = this.now();
      if (wasIdle) {
        this.report();
      }
    };
    const onChange = () => this.report();
    for (const name of INPUT_EVENTS) {
      window.addEventListener(name, onInput, { passive: true, capture: true });
    }
    this.document.addEventListener('visibilitychange', onChange);
    window.addEventListener('focus', onChange);
    window.addEventListener('blur', onChange);
    window.addEventListener('pagehide', onChange);
    // After a reconnect the API knows nothing about this window.
    const connected = this.socket.connectedChanges$.subscribe((open) => {
      if (open) {
        this.sent = '';
        this.report();
      }
    });
    this.timer = setInterval(() => this.report(true), PRESENCE_INTERVAL_MS);
    this.destroyRef.onDestroy(() => {
      subscription.unsubscribe();
      connected.unsubscribe();
      for (const name of INPUT_EVENTS) {
        window.removeEventListener(name, onInput, { capture: true });
      }
      this.document.removeEventListener('visibilitychange', onChange);
      window.removeEventListener('focus', onChange);
      window.removeEventListener('blur', onChange);
      window.removeEventListener('pagehide', onChange);
      if (this.timer) {
        clearInterval(this.timer);
      }
    });
    this.report();
  }

  /** Visible, focused and used recently. */
  active(): boolean {
    return (
      this.document.visibilityState === 'visible' &&
      this.document.hasFocus() &&
      this.now() - this.lastInput < IDLE_MS
    );
  }

  /** Sends the presence when it changed, or repeats it (`repeat`) while active. */
  report(repeat = false): void {
    const active = this.sessionId !== null && this.active();
    const key = `${this.sessionId}/${active}`;
    if (key === this.sent && !(repeat && active)) {
      return;
    }
    if (
      this.socket.send({ type: 'presence', sessionId: this.sessionId, active })
    ) {
      this.sent = key;
    }
  }
}
