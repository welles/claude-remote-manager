import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type {
  CreateRepositoryRequest,
  RepositoryBranchesResponse,
  RepositoryDto,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { GitHubRepositoryPicker } from '../github/github-repository-picker';
import {
  RepositoriesApi,
  errorMessage,
} from '../repositories/repositories-api';
import { AppIcon } from '../ui/icon';
import { SessionsApi } from './sessions-api';

/** Same rule as the API (and the new-session form). */
const PROJECT_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** Where the repository to add comes from (as in the new-session form). */
export type AdditionSource = 'registered' | 'github' | 'url' | 'project';

/**
 * "Add repository" in the session details: the same choices as the
 * new-session form (a registered repository or local project, one from
 * GitHub through the GitHub App, one by clone URL, a new local project)
 * and the base branch. Repositories from GitHub, by URL and new projects
 * are registered first through the same routes as there. The session then
 * prepares the clone in the background (its progress is in the history).
 */
@Component({
  selector: 'app-add-repository',
  imports: [
    AppIcon,
    FormsModule,
    GitHubRepositoryPicker,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  templateUrl: './add-repository.html',
  styleUrl: './add-repository.scss',
})
export class AddRepository {
  private readonly sessionsApi = inject(SessionsApi);
  private readonly repositoriesApi = inject(RepositoriesApi);

  readonly session = input.required<SessionDto>();
  /** Requests can be sent (connected). */
  readonly enabled = input(true);
  /** The session after the request was accepted. */
  readonly changed = output<SessionDto>();

  protected readonly open = signal(false);
  protected readonly source = signal<AdditionSource>('registered');
  protected readonly repositories = signal<RepositoryDto[]>([]);
  protected readonly loaded = signal(false);
  protected readonly repositoryId = signal('');
  protected readonly baseBranch = signal('');
  protected readonly branches = signal(
    new Map<string, RepositoryBranchesResponse>(),
  );
  protected cloneUrl = '';
  protected projectName = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Repositories that are part of the session already. */
  private readonly present = computed(
    () =>
      new Set(
        this.session().directories.flatMap((directory) =>
          directory.repository ? [directory.repository.id] : [],
        ),
      ),
  );
  /** Registered repositories the session does not have yet. */
  protected readonly choices = computed(() =>
    this.repositories().filter(
      (repository) => !this.present().has(repository.id),
    ),
  );
  /** A repository is being added already (one at a time). */
  protected readonly adding = computed(() =>
    this.session().directories.some(
      (directory) => directory.addition?.state === 'preparing',
    ),
  );
  /** Whether the session can take another repository now. */
  protected readonly available = computed(() => {
    const session = this.session();
    return (
      !session.archivedAt &&
      session.status !== 'preparing' &&
      session.pendingMessage === null &&
      !session.directories.some((directory) => directory.state === 'removed')
    );
  });
  protected readonly projectValid = () =>
    PROJECT_NAME_PATTERN.test(this.projectName.trim());

  protected show(): void {
    this.open.set(true);
    this.error.set(null);
    if (!this.loaded()) {
      this.repositoriesApi.list().subscribe({
        next: ({ repositories }) => {
          this.repositories.set(repositories);
          this.loaded.set(true);
          if (repositories.length === 0) {
            this.source.set('github');
          }
        },
        error: (error: unknown) => {
          this.loaded.set(true);
          this.error.set(
            errorMessage(error, 'The repositories could not be loaded.'),
          );
        },
      });
    }
  }

  protected hide(): void {
    this.open.set(false);
    this.error.set(null);
  }

  protected setSource(source: AdditionSource): void {
    this.source.set(source);
    this.error.set(null);
  }

  protected choose(repositoryId: string): void {
    this.repositoryId.set(repositoryId);
    this.baseBranch.set('');
    if (repositoryId && !this.branches().has(repositoryId)) {
      this.repositoriesApi.branches(repositoryId).subscribe({
        next: (branches) =>
          this.branches.update((map) =>
            new Map(map).set(repositoryId, branches),
          ),
        error: () => undefined,
      });
    }
  }

  protected branchOptions(): string[] {
    return this.branches().get(this.repositoryId())?.branches ?? [];
  }

  protected defaultLabel(): string {
    const id = this.repositoryId();
    const known =
      this.branches().get(id)?.defaultBranch ??
      this.repositories().find((repository) => repository.id === id)
        ?.defaultBranch;
    return known ? `Default (${known})` : 'Default branch';
  }

  /** A repository chosen from GitHub (registered by the picker). */
  protected pickedFromGitHub(repository: RepositoryDto): void {
    this.registered(repository);
  }

  /** Registers a repository by URL or a new local project, then chooses it. */
  protected register(): void {
    const request: CreateRepositoryRequest | null =
      this.source() === 'url'
        ? this.cloneUrl.trim()
          ? { cloneUrl: this.cloneUrl.trim() }
          : null
        : this.projectValid()
          ? { projectName: this.projectName.trim() }
          : null;
    if (!request || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.repositoriesApi.create(request).subscribe({
      next: (repository) => {
        this.busy.set(false);
        this.cloneUrl = '';
        this.projectName = '';
        this.registered(repository);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.error.set(
          errorMessage(error, 'The repository could not be registered.'),
        );
      },
    });
  }

  protected add(): void {
    const repositoryId = this.repositoryId();
    if (!repositoryId || this.busy() || !this.enabled()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.sessionsApi
      .addRepository(this.session().id, {
        repositoryId,
        ...(this.baseBranch() ? { baseBranch: this.baseBranch() } : {}),
      })
      .subscribe({
        next: (session) => {
          this.busy.set(false);
          this.repositoryId.set('');
          this.baseBranch.set('');
          this.open.set(false);
          this.changed.emit(session);
        },
        error: (error: unknown) => {
          this.busy.set(false);
          this.error.set(
            errorMessage(error, 'The repository could not be added.'),
          );
        },
      });
  }

  /** A newly registered repository: listed and chosen. */
  private registered(repository: RepositoryDto): void {
    this.repositories.update((list) =>
      list.some((entry) => entry.id === repository.id)
        ? list
        : [...list, repository].sort((a, b) =>
            a.fullName.localeCompare(b.fullName),
          ),
    );
    this.source.set('registered');
    if (this.present().has(repository.id)) {
      this.error.set(`${repository.fullName} is already part of this session.`);
      return;
    }
    this.choose(repository.id);
  }
}
