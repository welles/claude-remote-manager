import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import type {
  BrowsedFileDto,
  BrowseResponse,
  FileChangeStatus,
  SessionDiffResponse,
  ShownFileDto,
} from '@claude-remote-manager/shared-types';
import { FileViewer } from '../shown-files/file-viewer';
import { AppIcon } from '../ui/icon';
import { AppPageBar } from '../ui/page-bar';
import { browsedContentUrl, SessionsApi } from '../sessions/sessions-api';
import { buildTree, rowKey, treeRows, type TreeRow } from './file-tree';

/** A file opened in the viewer. */
interface OpenedFile {
  browsed: BrowsedFileDto;
  file: ShownFileDto;
  url: string;
  downloadUrl: string;
}

/**
 * The files of a session's directories (`/sessions/:id/files`): a tree per
 * directory (git's tracked and untracked files, not ignored ones), files
 * the session changed marked, a filter over all paths, and the file viewer
 * with "Reference in message" (back to the session with `@path` in the
 * input).
 */
@Component({
  selector: 'app-session-files-page',
  host: { class: 'app-page' },
  imports: [AppIcon, AppPageBar, FileViewer],
  templateUrl: './session-files-page.html',
  styleUrl: './session-files-page.scss',
})
export class SessionFilesPage {
  private readonly api = inject(SessionsApi);
  private readonly router = inject(Router);

  protected readonly id = toSignal(
    inject(ActivatedRoute).paramMap.pipe(
      map((params) => params.get('id') ?? ''),
    ),
    { initialValue: '' },
  );
  protected readonly listing = signal<BrowseResponse | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly filter = signal('');
  private readonly expanded = signal<ReadonlySet<string>>(new Set());
  /** Folders whose files are all shown (beyond the first ones). */
  private readonly complete = signal<ReadonlySet<string>>(new Set());
  private readonly diff = signal<SessionDiffResponse | null>(null);
  private readonly changes = computed(() => {
    const diff = this.diff();
    const listing = this.listing();
    return diff && listing
      ? changesOf(diff, listing)
      : new Map<string, FileChangeStatus>();
  });
  protected readonly opened = signal<OpenedFile | null>(null);
  protected readonly opening = signal<string | null>(null);

  private readonly trees = computed(() =>
    (this.listing()?.directories ?? []).map((directory) => ({
      directory,
      tree: buildTree(directory.files),
    })),
  );
  protected readonly sections = computed(() =>
    this.trees().map(({ directory, tree }) => ({
      directory,
      title: directory.repository ?? 'Scratch directory',
      rows: treeRows(
        directory,
        tree,
        this.expanded(),
        this.changes(),
        this.filter(),
        this.complete(),
      ),
    })),
  );
  protected readonly changedCount = computed(() => this.changes().size);

  constructor() {
    const id = this.id();
    this.api.browse(id).subscribe({
      next: (listing) => this.listing.set(listing),
      error: () => this.error.set('The files could not be listed.'),
    });
    this.api
      .diff(id)
      .pipe(catchError(() => of<SessionDiffResponse | null>(null)))
      .subscribe((diff) => this.diff.set(diff));
  }

  protected toggle(row: TreeRow): void {
    if (!row.folder) {
      this.open(row);
      return;
    }
    this.expanded.update((keys) => {
      const next = new Set(keys);
      if (next.has(row.key)) {
        next.delete(row.key);
      } else {
        next.add(row.key);
      }
      return next;
    });
  }

  protected setFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  /** Shows all files of a folder whose list was cut short. */
  protected showAll(row: TreeRow): void {
    this.complete.update((keys) => new Set(keys).add(row.key));
  }

  private open(row: TreeRow): void {
    const id = this.id();
    this.error.set(null);
    this.opening.set(row.key);
    this.api.browsedFile(id, row.directory, row.path).subscribe({
      next: (browsed) => {
        this.opening.set(null);
        this.opened.set({
          browsed,
          file: {
            id: '',
            origin: 'show_file',
            path: browsed.path,
            name: browsed.name,
            caption: null,
            kind: browsed.kind,
            mediaType: browsed.mediaType,
            language: browsed.language,
            size: browsed.size,
            snapshot: false,
            createdAt: '',
          },
          url: browsedContentUrl(id, row.directory, row.path),
          downloadUrl: browsedContentUrl(id, row.directory, row.path, {
            download: true,
          }),
        });
      },
      error: () => {
        this.opening.set(null);
        this.error.set(`${row.path} could not be opened.`);
      },
    });
  }

  /** Back to the session with `@path` added to the input. */
  protected reference(file: BrowsedFileDto): void {
    void this.router.navigate(['/sessions', this.id()], {
      queryParams: { mention: file.mention },
    });
  }
}

/** Changed files by `<directory>:<path>` (diff repositories by path). */
export function changesOf(
  diff: SessionDiffResponse,
  listing: BrowseResponse,
): Map<string, FileChangeStatus> {
  const changes = new Map<string, FileChangeStatus>();
  for (const repository of diff.repositories) {
    const directory = listing.directories.find(
      (candidate) => candidate.path === repository.path,
    );
    if (!directory) {
      continue;
    }
    const position = directory.directory;
    // Only files there are rows for (not deleted ones).
    const listed = new Set(directory.files);
    for (const file of repository.files.filter((f) => listed.has(f.path))) {
      changes.set(rowKey(position, file.path), file.status);
    }
  }
  return changes;
}
