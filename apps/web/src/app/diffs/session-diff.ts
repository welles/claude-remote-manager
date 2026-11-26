import { Component, inject, input, signal, type OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import type {
  RepositoryDiff,
  SessionDiffFile,
  SessionDiffResponse,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { SessionsApi } from '../sessions/sessions-api';
import { AppDatePipe } from '../ui/dates';
import { AppIcon } from '../ui/icon';
import { commitQuery } from './commit-links';
import { DiffFiles } from './diff-files';
import { DiffLayoutPreference } from './diff-layout';
import type { DiffLayout } from './diff-rows';

/**
 * Everything a session changed against the commit each of its clones
 * started from: per repository its commits (each linking to its own diff),
 * a file list (status, path, line counts) and each file's diff, unified or
 * side by side (the viewer's choice is kept). Files left out of the
 * response for their size are loaded on request. Used by the session's
 * changes page and the cleanup of sessions.
 */
@Component({
  selector: 'app-session-diff',
  imports: [
    AppDatePipe,
    AppIcon,
    DiffFiles,
    MatButtonModule,
    MatProgressBarModule,
    RouterLink,
  ],
  templateUrl: './session-diff.html',
  host: { class: 'flex min-w-0 flex-col gap-3' },
})
export class SessionDiff implements OnInit {
  private readonly api = inject(SessionsApi);
  private readonly preference = inject(DiffLayoutPreference);

  readonly sessionId = input.required<string>();
  /** Link each commit to its diff (not in dialogs). */
  readonly linkCommits = input(false);

  protected readonly layout = this.preference.layout;
  protected readonly diff = signal<SessionDiffResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly commitQuery = commitQuery;

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.diff(this.sessionId()).subscribe({
      next: (diff) => {
        this.diff.set(diff);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.error.set(errorMessage(error, 'The changes could not be loaded.'));
        this.loading.set(false);
      },
    });
  }

  protected setLayout(layout: DiffLayout): void {
    this.preference.set(layout);
  }

  /** Loads one file of a repository's diff left out for its size. */
  protected loader(repository: RepositoryDiff) {
    return (file: SessionDiffFile) =>
      this.api.fileDiff(
        this.sessionId(),
        repository.repositoryId,
        file.path,
        file.oldPath,
        repository.branch,
      );
  }
}
