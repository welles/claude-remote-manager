import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { SessionDiff } from './session-diff';

/** The whole-session diff as its own page (`/sessions/:id/changes`). */
@Component({
  selector: 'app-session-changes-page',
  imports: [MatButtonModule, RouterLink, SessionDiff],
  template: `
    <a matButton [routerLink]="['/sessions', id()]" class="back">← Session</a>
    <h1>Changes</h1>
    @for (sessionId of [id()]; track sessionId) {
      <app-session-diff [sessionId]="sessionId" />
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .back {
      margin-left: -12px;
    }
    h1 {
      font: var(--mat-sys-title-large);
      margin: 4px 0 8px;
    }
  `,
})
export class SessionChangesPage {
  protected readonly id = toSignal(
    inject(ActivatedRoute).paramMap.pipe(
      map((params) => params.get('id') ?? ''),
    ),
    { initialValue: '' },
  );
}
