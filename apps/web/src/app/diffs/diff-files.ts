import { Component, input, linkedSignal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type { SessionDiffFile } from '@claude-remote-manager/shared-types';
import type { Observable } from 'rxjs';
import { errorMessage } from '../repositories/repositories-api';
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

/** The colour of a status letter. */
const STATUS_TONES: Record<SessionDiffFile['status'], string> = {
  added: 'text-diff-add',
  modified: '',
  deleted: 'text-diff-del',
  renamed: 'text-secondary',
  copied: 'text-secondary',
  type_changed: '',
};

/** Key of a file within one list. */
const fileKey = (file: SessionDiffFile) =>
  `${file.oldPath ?? ''}\u0000${file.path}`;

/**
 * The files of a diff (of a session clone or of one commit): a list
 * (status, path, line counts) linking to each file's diff below. Files left
 * out for their size are loaded on request with `loader`.
 */
@Component({
  selector: 'app-diff-files',
  imports: [DiffView, MatButtonModule],
  host: { class: 'block' },
  template: `
    <ul class="my-2 list-none p-0" data-testid="file-list">
      @for (file of files(); track $index; let f = $index) {
        <li class="flex items-baseline gap-2 py-0.5">
          <span
            class="w-[1.5ch] font-mono text-[12px]/none font-semibold {{
              letterTones[file.status]
            }}"
            [title]="file.status.replace('_', ' ')"
            >{{ letters[file.status] }}</span
          >
          <a
            class="min-w-0 flex-1 wrap-anywhere whitespace-pre-wrap"
            [href]="'#' + anchor(f)"
            (click)="jump($event, anchor(f))"
          >
            @if (file.oldPath) {
              <span class="text-on-surface-variant">{{ file.oldPath }} → </span>
            }
            {{ file.path }}</a
          >
          <span class="whitespace-nowrap type-body-small">
            @if (file.binary) {
              binary
            } @else {
              <span class="text-diff-add">+{{ file.additions }}</span>
              <span class="text-diff-del">−{{ file.deletions }}</span>
            }
          </span>
        </li>
      }
    </ul>
    @if (fileCount() > files().length) {
      <p
        class="my-1 text-on-surface-variant wrap-anywhere"
        data-testid="files-limited"
      >
        Showing {{ files().length }} of {{ fileCount() }} changed files.
      </p>
    }
    @for (file of files(); track $index; let f = $index) {
      @let shownFile = shown(file);
      <details
        class="my-2 border-t border-outline-variant pt-1"
        open
        [id]="anchor(f)"
        data-testid="file-diff"
      >
        <summary class="flex cursor-pointer items-baseline gap-2 py-0.5">
          <span
            class="w-[1.5ch] font-mono text-[12px]/none font-semibold {{
              letterTones[file.status]
            }}"
            >{{ letters[file.status] }}</span
          >
          <code class="min-w-0 flex-1 wrap-anywhere whitespace-pre-wrap">
            @if (file.oldPath) {
              <span class="text-on-surface-variant">{{ file.oldPath }} → </span>
            }
            {{ file.path }}</code
          >
          @if (!file.binary) {
            <span class="whitespace-nowrap type-body-small"
              ><span class="text-diff-add">+{{ file.additions }}</span>
              <span class="text-diff-del">−{{ file.deletions }}</span></span
            >
          }
        </summary>
        @if (shownFile.content === 'included') {
          <app-diff-view [diff]="shownFile" [layout]="layout()" />
        } @else {
          <p
            class="my-1 text-on-surface-variant wrap-anywhere"
            data-testid="file-left-out"
          >
            {{
              shownFile.content === 'too_large'
                ? 'This file has too many changed lines to show here.'
                : 'Left out: the diff reached its size limit.'
            }}
            @let state = fileState().get(fileKey(file));
            @if (state === undefined) {
              <button matButton (click)="load(file)" data-testid="load-file">
                Show this file
              </button>
            } @else if (state === null) {
              Loading…
            } @else {
              <span class="text-error">{{ state }}</span>
            }
          </p>
        }
      </details>
    }
  `,
})
export class DiffFiles {
  readonly files = input.required<SessionDiffFile[]>();
  /** All changed files, also those beyond the listed ones. */
  readonly fileCount = input.required<number>();
  readonly layout = input<DiffLayout>('unified');
  /** Prefix of the element IDs of the files' diffs (unique on the page). */
  readonly idPrefix = input.required<string>();
  /** Loads one file left out of the diff. */
  readonly loader =
    input.required<(file: SessionDiffFile) => Observable<SessionDiffFile>>();

  /** Files loaded on their own, by key; reset with new files. */
  protected readonly loaded = linkedSignal({
    source: this.files,
    computation: () => new Map<string, SessionDiffFile>(),
  });
  /** Files being loaded, or that failed to load (message). */
  protected readonly fileState = linkedSignal({
    source: this.files,
    computation: () => new Map<string, string | null>(),
  });
  protected readonly letters = STATUS_LETTERS;
  protected readonly letterTones = STATUS_TONES;
  protected readonly fileKey = fileKey;

  /** The file with its content, if it was loaded on its own. */
  protected shown(file: SessionDiffFile): SessionDiffFile {
    return this.loaded().get(fileKey(file)) ?? file;
  }

  protected load(file: SessionDiffFile): void {
    const key = fileKey(file);
    this.fileState.update((states) => new Map(states).set(key, null));
    this.loader()(file).subscribe({
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
  protected anchor(fileIndex: number): string {
    return `${this.idPrefix()}-${fileIndex}`;
  }

  protected jump(event: Event, id: string): void {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }
}
