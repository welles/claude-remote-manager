import { Injectable, signal } from '@angular/core';

/**
 * How many sessions are blocked on the user (see `needsUser`), for the
 * navigation's badge. Kept up to date by `AppBadge`, which runs in the
 * background chunk; this holder stays tiny for the start bundle.
 */
@Injectable({ providedIn: 'root' })
export class NeedsYouCount {
  readonly count = signal(0);
}
