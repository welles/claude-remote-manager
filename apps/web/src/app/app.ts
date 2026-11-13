import { Component, DestroyRef, Injector, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatToolbarModule } from '@angular/material/toolbar';
import { RouterLink, RouterOutlet } from '@angular/router';
import { LimitsIndicator } from './limits/limits-indicator';
import { AccessSession } from './pwa/access-session';
import { SessionSocket } from './sessions/session-socket';

@Component({
  imports: [
    LimitsIndicator,
    MatButtonModule,
    MatToolbarModule,
    RouterLink,
    RouterOutlet,
  ],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly access = inject(AccessSession);

  constructor() {
    // The connection carries the presence (no notifications about what is
    // in front of the user) and keeps the badge current.
    inject(SessionSocket).connect();
    const injector = inject(Injector);
    let destroyed = false;
    inject(DestroyRef).onDestroy(() => (destroyed = true));
    void import('./pwa/background').then((module) => {
      if (!destroyed) {
        module.startBackground(injector);
      }
    });
    addEventListener('online', () => void this.access.check());
  }
}
