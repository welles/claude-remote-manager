import { Component, inject, input, signal, type OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { AppIcon } from '../ui/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type {
  RepositoryDiff,
  SessionDiffFile,
  SessionDiffResponse,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { SessionsApi } from '../sessions/sessions-api';
import { DiffLayoutPreference } from './diff-layout';
import type { DiffLayout } from './diff-rows';
import { DiffView } from './diff-view';

const STATUS_LETTERS: Record<SessionDiffFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  type_changed: 'T',
};

/** Key of a file within the session diff. */
const fileKey = (repository: RepositoryDiff, file: SessionDiffFile) =>
  `${repository.repositoryId}\u0000${file.oldPath ?? ''}\u0000${file.path}`;

/**
 * Everything a session changed against the commit each of its clones
 * started from: per repository a file list (status, path, line counts) and
 * each file's diff, unified or side by side (the viewer's choice is kept).
 * Files left out of the response for their size are loaded on request.
 * Used by the session's changes page and the cleanup of sessions.
 */
@Component({
  selector: 'app-session-diff',
  imports: [DiffView, MatButtonModule, AppIcon, MatProgressBarModule],
  templateUrl: './session-diff.html',
  styleUrl: './session-diff.scss',
})
export class SessionDiff implements OnInit {
  private readonly api = inject(SessionsApi);
  private readonly preference = inject(DiffLayoutPreference);

  readonly sessionId = input.required<string>();

  protected readonly layout = this.preference.layout;
  protected readonly diff = signal<SessionDiffResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Files loaded on their own, by key. */
  protected readonly loaded = signal(new Map<string, SessionDiffFile>());
  /** Files being loaded, or that failed to load (message). */
  protected readonly fileState = signal(new Map<string, string | null>());
  protected readonly letters = STATUS_LETTERS;
  protected readonly fileKey = fileKey;

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.diff(this.sessionId()).subscribe({
      next: (diff) => {
        this.diff.set(diff);
        this.loaded.set(new Map());
        this.fileState.set(new Map());
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

  /** The file with its content, if it was loaded on its own. */
  protected shown(
    repository: RepositoryDiff,
    file: SessionDiffFile,
  ): SessionDiffFile {
    return this.loaded().get(fileKey(repository, file)) ?? file;
  }

  protected load(repository: RepositoryDiff, file: SessionDiffFile): void {
    const key = fileKey(repository, file);
    this.fileState.update((states) => new Map(states).set(key, null));
    this.api
      .fileDiff(
        this.sessionId(),
        repository.repositoryId,
        file.path,
        file.oldPath,
      )
      .subscribe({
        next: (loaded) => {
          this.loaded.update((files) => new Map(files).set(key, loaded));
          this.fileState.update((states) => {
            const next = new Map(states);
            next.delete(key);
            return next;
          });
        },
        error: (error: unknown) =>
          this.fileState.update((states) =>
            new Map(states).set(
              key,
              errorMessage(error, 'The diff of this file could not be loaded.'),
            ),
          ),
      });
  }

  /** Element ID of a file's diff, for the links of the file list. */
  protected anchor(repositoryIndex: number, fileIndex: number): string {
    return `diff-${repositoryIndex}-${fileIndex}`;
  }

  protected jump(event: Event, id: string): void {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }
}
