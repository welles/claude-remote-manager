import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import {
  isActiveDirectory,
  workingDirectoryOf,
  type SessionDto,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { AppDialog } from '../ui/dialog';
import { AppIcon } from '../ui/icon';
import { SessionsApi } from './sessions-api';

/** `acme/app + acme/lib · claude/fix-…`, `Scratch`, or empty. */
export function sessionSubtitle(session: SessionDto): string {
  const names = session.directories
    .filter(isActiveDirectory)
    .map((directory) =>
      directory.kind === 'scratch'
        ? 'Scratch'
        : (directory.repository?.fullName ?? null),
    )
    .filter((name): name is string => name !== null);
  // The branch of the clone Claude Code works in.
  const branch = workingDirectoryOf(session)?.branch;
  return [names.join(' + '), branch].filter(Boolean).join(' · ');
}

/**
 * The session's title in the app bar, with its repositories and branch
 * below, and "Rename" (a dialog): only the title changes, the session
 * branch and the directory names keep theirs (the form says so).
 */
@Component({
  selector: 'app-session-title',
  imports: [
    AppDialog,
    AppIcon,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  template: `
    @let s = session();
    <div class="titles">
      <h1 class="title" data-testid="session-title">
        {{ s.title || 'Untitled session' }}
      </h1>
      @if (subtitle()) {
        <p class="subtitle">{{ subtitle() }}</p>
      }
    </div>
    <button
      type="button"
      class="app-icon-btn"
      (click)="start()"
      aria-label="Rename"
      title="Rename"
      data-testid="rename"
    >
      <app-icon name="edit" />
    </button>
    <app-dialog
      heading="Rename session"
      initialFocus="[data-testid=rename-input]"
      (closed)="renaming.set(false)"
    >
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
          </mat-form-field>
          <p class="hint">
            Only the title changes:
            {{ branchNote(s) }}
            the directory names stay as they are. After saving, Claude no longer
            changes the title, also when you keep it as it is.
          </p>
          @if (error(); as text) {
            <p class="error" role="alert">{{ text }}</p>
          }
        </form>
      }
      @if (renaming()) {
        <div dialog-actions>
          <button matButton type="button" (click)="cancel()">Cancel</button>
          <button
            matButton="filled"
            type="button"
            (click)="save()"
            [disabled]="!draft().trim() || busy()"
            data-testid="rename-save"
          >
            Save
          </button>
        </div>
      }
    </app-dialog>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: var(--app-space-1);
      min-width: 0;
    }
    .titles {
      flex: 0 1 auto;
      min-width: 0;
    }
    .title {
      margin: 0;
      font: var(--mat-sys-title-medium);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .subtitle {
      margin: 0;
      font: var(--mat-sys-body-small);
      font-family: var(--app-font-mono);
      color: var(--mat-sys-on-surface-variant);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rename {
      display: flex;
      flex-direction: column;
      gap: var(--app-space-2);
    }
    mat-form-field {
      width: 100%;
    }
    .hint {
      margin: 0;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .error {
      margin: 0;
      color: var(--mat-sys-error);
    }
  `,
})
export class SessionTitle {
  private readonly api = inject(SessionsApi);
  private readonly dialog = viewChild.required(AppDialog);

  readonly session = input.required<SessionDto>();
  readonly renamed = output<SessionDto>();

  protected readonly subtitle = computed(() => sessionSubtitle(this.session()));

  /** "the branch … and" for the rename hint: the working directory's. */
  protected branchNote(session: SessionDto): string {
    const branch = workingDirectoryOf(session)?.branch;
    return branch ? `the branch ${branch} and` : '';
  }
  protected readonly renaming = signal(false);
  protected readonly draft = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  start(): void {
    this.draft.set(this.session().title ?? '');
    this.error.set(null);
    this.renaming.set(true);
    this.dialog().open();
  }

  protected cancel(): void {
    this.dialog().close();
    this.renaming.set(false);
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
        this.dialog().close();
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
