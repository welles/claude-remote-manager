import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import { AppPageBar } from '../ui/page-bar';
import { CommitDiff } from './commit-diff';
import { SessionDiff } from './session-diff';

/**
 * The whole-session diff as its own page (`/sessions/:id/changes`), or one
 * commit of a clone with `?repository=…&branch=…&commit=…`.
 */
@Component({
  selector: 'app-session-changes-page',
  host: { class: 'app-page [--app-page-max:1320px]' },
  imports: [AppPageBar, CommitDiff, SessionDiff],
  template: `
    <app-page-bar
      [heading]="commit().sha ? 'Commit' : 'Changes'"
      [back]="['/sessions', id()]"
      backLabel="Back to the session"
    />
    @let c = commit();
    @if (c.sha && c.repositoryId) {
      <app-commit-diff
        [sessionId]="id()"
        [repositoryId]="c.repositoryId"
        [branch]="c.branch"
        [sha]="c.sha"
      />
    } @else {
      @for (sessionId of [id()]; track sessionId) {
        <app-session-diff [sessionId]="sessionId" [linkCommits]="true" />
      }
    }
  `,
})
export class SessionChangesPage {
  private readonly route = inject(ActivatedRoute);

  protected readonly id = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' },
  );
  protected readonly commit = toSignal(
    this.route.queryParamMap.pipe(
      map((params) => ({
        repositoryId: params.get('repository'),
        branch: params.get('branch'),
        sha: params.get('commit'),
      })),
    ),
    { initialValue: { repositoryId: null, branch: null, sha: null } },
  );
}
