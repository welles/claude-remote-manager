import { AppDatePipe } from '../ui/dates';
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
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import type {
  ConnectGitHubRequest,
  CreateRepositoryRequest,
  GitHubInstallationDto,
  RepositoryDto,
  SessionCloneDto,
} from '@claude-remote-manager/shared-types';
import { GitHubApi } from '../github/github-api';
import { GitHubRepositoryPicker } from '../github/github-repository-picker';
import { RepositoriesApi, errorMessage } from './repositories-api';

/** How often the page reloads while a clone or fetch runs. */
export const ACTIVITY_POLL_MS = 2000;

/** Session slug of a clone path `<sessions>/<slug>/<owner>/<name>`. */
export const cloneSlug = (path: string) =>
  path.split('/').filter(Boolean).at(-3) ?? path;

/**
 * Registered repositories and local projects with their default branch and
 * session clones; orphaned clones are marked. Repositories are added by
 * clone URL, local projects by name; each has an editable setup script.
 */
@Component({
  selector: 'app-repository-list',
  imports: [
    AppDatePipe,
    FormsModule,
    GitHubRepositoryPicker,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatSelectModule,
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
  private readonly github = inject(GitHubApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly repositories = signal<RepositoryDto[]>([]);
  protected readonly strayDirectories = signal<string[]>([]);
  protected readonly busy = computed(() =>
    this.repositories().some((repository) => repository.activity !== null),
  );

  protected cloneUrl = '';
  protected projectName = '';
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

  /** Local project being put on GitHub, and the form fields. */
  protected readonly publishing = signal<string | null>(null);
  protected readonly owners = signal<GitHubInstallationDto[]>([]);
  protected publishMode: 'create' | 'attach' = 'create';
  protected publishOwner = '';
  protected publishName = '';
  protected publishPrivate = true;
  protected publishExisting = '';

  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => this.stopPolling());
    this.load();
  }

  protected add(): void {
    const cloneUrl = this.cloneUrl.trim();
    if (cloneUrl) {
      this.register({ cloneUrl }, () => (this.cloneUrl = ''));
    }
  }

  protected addProject(): void {
    const projectName = this.projectName.trim();
    if (projectName) {
      this.register({ projectName }, () => (this.projectName = ''));
    }
  }

  private register(request: CreateRepositoryRequest, done: () => void): void {
    if (this.adding()) {
      return;
    }
    this.adding.set(true);
    this.addError.set(null);
    this.api.create(request).subscribe({
      next: (repository) => {
        this.adding.set(false);
        done();
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

  /** A repository chosen from GitHub is registered and being cloned. */
  protected pickedFromGitHub(repository: RepositoryDto): void {
    this.upsert(repository);
    this.schedulePoll();
  }

  protected openPublish(repository: RepositoryDto): void {
    this.publishMode = 'create';
    this.publishName = repository.name;
    this.publishPrivate = true;
    this.publishExisting = '';
    this.actionError.set(null);
    this.publishing.set(repository.id);
    this.github.status().subscribe({
      next: (status) => {
        if (!status.configured) {
          this.actionError.set({
            id: repository.id,
            message: `GitHub is not configured: ${status.problem}`,
          });
        }
        // The app can create repositories only in organizations.
        const organizations = status.installations.filter(
          (installation) => installation.accountType === 'Organization',
        );
        this.owners.set(organizations);
        this.publishOwner ||= organizations[0]?.account ?? '';
        if (organizations.length === 0) {
          this.publishMode = 'attach';
        }
      },
      error: () => this.owners.set([]),
    });
  }

  protected publish(repository: RepositoryDto): void {
    this.saving.set(true);
    this.actionError.set(null);
    const fail = (error: unknown) => {
      this.saving.set(false);
      this.actionError.set({
        id: repository.id,
        message: errorMessage(error, 'The project could not be put on GitHub.'),
      });
    };
    const connect = (request: ConnectGitHubRequest) =>
      this.api.connectGitHub(repository.id, request).subscribe({
        next: (updated) => {
          this.saving.set(false);
          this.publishing.set(null);
          this.upsert(updated);
        },
        error: fail,
      });
    if (this.publishMode === 'create') {
      connect({
        mode: 'create',
        owner: this.publishOwner,
        name: this.publishName.trim() || repository.name,
        private: this.publishPrivate,
      });
      return;
    }
    const wanted = this.publishExisting.trim().toLowerCase();
    this.github.repositories(wanted, { perPage: 100 }).subscribe({
      next: ({ repositories }) => {
        const found = repositories.find(
          (entry) => entry.fullName.toLowerCase() === wanted,
        );
        if (!found) {
          fail({
            error: {
              message: `${this.publishExisting.trim()} is not accessible to the GitHub App`,
            },
          });
          return;
        }
        connect({ mode: 'attach', githubRepositoryId: found.id });
      },
      error: fail,
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

  protected cloneLabel(clone: SessionCloneDto): string {
    return clone.sessionTitle || cloneSlug(clone.path);
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
