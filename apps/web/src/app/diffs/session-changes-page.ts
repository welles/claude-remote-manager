import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import { AppPageBar } from '../ui/page-bar';
import { SessionDiff } from './session-diff';

/** The whole-session diff as its own page (`/sessions/:id/changes`). */
@Component({
  selector: 'app-session-changes-page',
  host: { class: 'app-page' },
  imports: [AppPageBar, SessionDiff],
  template: `
    <app-page-bar
      heading="Changes"
      [back]="['/sessions', id()]"
      backLabel="Back to the session"
    />
    @for (sessionId of [id()]; track sessionId) {
      <app-session-diff [sessionId]="sessionId" />
    }
  `,
  styles: `
    :host {
      --app-page-max: 1320px;
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
