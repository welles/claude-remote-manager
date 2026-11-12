import { DatePipe } from '@angular/common';
import {
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { TextFieldModule } from '@angular/cdk/text-field';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { RouterLink } from '@angular/router';
import type {
  RepositoryDto,
  WorktreeDto,
} from '@claude-remote-manager/shared-types';
import { RepositoriesApi, errorMessage } from './repositories-api';

/** How often the page reloads while a clone or fetch runs. */
export const ACTIVITY_POLL_MS = 2000;

/** Last path segment, e.g. the session slug of a worktree. */
export const baseName = (path: string) =>
  path.split('/').filter(Boolean).at(-1) ?? path;

/**
 * Registered repositories with their default branch, worktrees and
 * sessions; orphaned worktrees are marked. Repositories are added by clone
 * URL; each has an editable setup script.
 */
@Component({
  selector: 'app-repository-list',
  imports: [
    DatePipe,
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    RouterLink,
    TextFieldModule,
  ],
  templateUrl: './repository-list.html',
  styleUrl: './repository-list.scss',
})
export class RepositoryList implements OnInit {
  private readonly api = inject(RepositoriesApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly baseName = baseName;
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly repositories = signal<RepositoryDto[]>([]);
  protected readonly strayDirectories = signal<string[]>([]);
  protected readonly busy = computed(() =>
    this.repositories().some((repository) => repository.activity !== null),
  );

  protected cloneUrl = '';
  protected readonly adding = signal(false);
  protected readonly addError = signal<string | null>(null);

  /** Repository whose setup script is being edited, and the draft. */
  protected readonly editing = signal<string | null>(null);
  protected setupDraft = '';
  protected readonly saving = signal(false);
  protected readonly actionError = signal<{
    id: string;
    message: string;
  } | null>(null);

  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => this.stopPolling());
    this.load();
  }

  protected add(): void {
    const cloneUrl = this.cloneUrl.trim();
    if (!cloneUrl || this.adding()) {
      return;
    }
    this.adding.set(true);
    this.addError.set(null);
    this.api.create({ cloneUrl }).subscribe({
      next: (repository) => {
        this.adding.set(false);
        this.cloneUrl = '';
        this.upsert(repository);
        this.schedulePoll();
      },
      error: (error: unknown) => {
        this.adding.set(false);
        this.addError.set(
          errorMessage(error, 'The repository could not be added.'),
        );
      },
    });
  }

  protected fetch(repository: RepositoryDto): void {
    this.actionError.set(null);
    this.api.fetch(repository.id).subscribe({
      next: (updated) => {
        this.upsert(updated);
        this.schedulePoll();
      },
      error: (error: unknown) =>
        this.actionError.set({
          id: repository.id,
          message: errorMessage(error, 'The fetch could not be started.'),
        }),
    });
  }

  protected editSetup(repository: RepositoryDto): void {
    this.setupDraft = repository.setupScript ?? '';
    this.actionError.set(null);
    this.editing.set(repository.id);
  }

  protected cancelSetup(): void {
    this.editing.set(null);
  }

  protected saveSetup(repository: RepositoryDto): void {
    this.saving.set(true);
    const script = this.setupDraft.trim() ? this.setupDraft : null;
    this.api.updateSetupScript(repository.id, script).subscribe({
      next: (updated) => {
        this.saving.set(false);
        this.editing.set(null);
        this.upsert(updated);
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.actionError.set({
          id: repository.id,
          message: errorMessage(error, 'The setup script could not be saved.'),
        });
      },
    });
  }

  protected worktreeLabel(worktree: WorktreeDto): string {
    return worktree.sessionTitle || baseName(worktree.path);
  }

  private load(): void {
    this.api.list().subscribe({
      next: ({ repositories, strayDirectories }) => {
        this.repositories.set(repositories);
        this.strayDirectories.set(strayDirectories);
        this.loading.set(false);
        this.loadError.set(null);
        if (this.busy()) {
          this.schedulePoll();
        }
      },
      error: () => {
        this.loadError.set('The repositories could not be loaded.');
        this.loading.set(false);
      },
    });
  }

  private upsert(repository: RepositoryDto): void {
    this.repositories.update((list) => {
      const index = list.findIndex((entry) => entry.id === repository.id);
      const next =
        index >= 0
          ? list.map((entry, i) => (i === index ? repository : entry))
          : [...list, repository];
      return next.sort((a, b) => a.fullName.localeCompare(b.fullName));
    });
  }

  /** Reloads while clones or fetches run, so their result shows up. */
  private schedulePoll(): void {
    this.stopPolling();
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.load();
    }, ACTIVITY_POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
