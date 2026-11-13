import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { SessionDto } from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { SessionsApi } from './sessions-api';

/**
 * The session's title with "Rename": only the title changes, the session
 * branch and the directory names keep theirs (the form says so).
 */
@Component({
  selector: 'app-session-title',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    @let s = session();
    @if (renaming()) {
      <form class="rename" (ngSubmit)="save()" data-testid="rename-form">
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>Title</mat-label>
          <input
            matInput
            name="title"
            maxlength="200"
            [ngModel]="draft()"
            (ngModelChange)="draft.set($event)"
            data-testid="rename-input"
          />
          <mat-hint
            >Only the title changes:
            {{
              s.directories[0]?.branch
                ? 'the branch ' + s.directories[0].branch + ' and'
                : ''
            }}
            the directory names stay as they are.</mat-hint
          >
        </mat-form-field>
        @if (error(); as text) {
          <p class="error" role="alert">{{ text }}</p>
        }
        <div class="buttons">
          <button
            matButton="filled"
            type="submit"
            [disabled]="!draft().trim() || busy()"
            data-testid="rename-save"
          >
            Save
          </button>
          <button matButton type="button" (click)="renaming.set(false)">
            Cancel
          </button>
        </div>
      </form>
    } @else {
      <div class="row">
        <h1 class="title" data-testid="session-title">
          {{ s.title || 'Untitled session' }}
        </h1>
        <button matButton type="button" (click)="start()" data-testid="rename">
          Rename
        </button>
      </div>
    }
  `,
  styles: `
    .row {
      display: flex;
      align-items: flex-start;
      gap: 4px;
    }
    .title {
      flex: 1;
      min-width: 0;
      font: var(--mat-sys-title-large);
      margin: 4px 0;
      overflow-wrap: anywhere;
    }
    .rename {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin: 4px 0;
    }
    mat-form-field {
      width: 100%;
    }
    .buttons {
      display: flex;
      gap: 8px;
    }
    .error {
      margin: 0;
      color: var(--mat-sys-error);
    }
  `,
})
export class SessionTitle {
  private readonly api = inject(SessionsApi);

  readonly session = input.required<SessionDto>();
  readonly renamed = output<SessionDto>();

  protected readonly renaming = signal(false);
  protected readonly draft = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected start(): void {
    this.draft.set(this.session().title ?? '');
    this.error.set(null);
    this.renaming.set(true);
  }

  protected save(): void {
    const title = this.draft().trim();
    if (!title) {
      return;
    }
    this.busy.set(true);
    this.api.rename(this.session().id, title).subscribe({
      next: (session) => {
        this.busy.set(false);
        this.renaming.set(false);
        this.renamed.emit(session);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(error, 'The session was not renamed.'));
      },
    });
  }
}
