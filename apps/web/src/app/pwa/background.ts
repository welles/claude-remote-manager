import type { Injector } from '@angular/core';
import { AppBadge } from './app-badge';
import { PresenceReporter } from './presence-reporter';

/**
 * What runs in the background of every page, loaded after the start (not
 * part of the initial bundle): the presence for notifications and the app
 * icon's badge.
 */
export function startBackground(injector: Injector): void {
  injector.get(PresenceReporter).start();
  injector.get(AppBadge).start();
}
