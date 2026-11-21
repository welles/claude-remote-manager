import { TextFieldModule } from '@angular/cdk/text-field';
import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import {
  DANGEROUS_PERMISSION_MODES,
  PERMISSION_MODE_INFO,
  SESSION_PERMISSION_MODES,
  type EnvironmentDto,
  type RepositoryBranchesResponse,
  type RepositoryDto,
} from '@claude-remote-manager/shared-types';
import {
  RepositoriesApi,
  errorMessage,
} from '../repositories/repositories-api';
import { ModelsStore } from '../sessions/models-store';
import { AppIcon } from '../ui/icon';
import {
  draftOf,
  draftProblems,
  emptyDraft,
  keepsStored,
  newEntry,
  newRepository,
  saveRequest,
  type EntryDraft,
  type EnvironmentDraft,
} from './environment-drafts';
import { EnvironmentsApi } from './environments-api';

/**
 * Form of an environment: name, default, presets of the new-session form
 * (repositories, model, permission mode), instructions, setup script,
 * variables and files. Secrets saved before are never shown: they can be
 * kept, replaced or removed.
 */
@Component({
  selector: 'app-environment-editor',
  host: { class: 'block' },
  imports: [
    AppIcon,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    TextFieldModule,
  ],
  templateUrl: './environment-editor.html',
})
export class EnvironmentEditor implements OnInit {
  private readonly api = inject(EnvironmentsApi);
  private readonly repositoriesApi = inject(RepositoriesApi);
  private readonly modelsStore = inject(ModelsStore);

  /** The environment to edit; `null` for a new one. */
  readonly environment = input<EnvironmentDto | null>(null);
  readonly saved = output<EnvironmentDto>();
  readonly cancelled = output<void>();

  protected readonly draft = signal<EnvironmentDraft>(emptyDraft());
  protected readonly problems = computed(() => draftProblems(this.draft()));
  /** Problems are shown once the user tried to save. */
  protected readonly attempted = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly repositories = signal<RepositoryDto[]>([]);
  protected readonly branches = signal(
    new Map<string, RepositoryBranchesResponse>(),
  );
  /** Models with a value (Claude Code's default is "no preset"). */
  protected readonly modelOptions = computed(() =>
    this.modelsStore.models().filter((option) => option.value !== null),
  );
  protected readonly modeOptions = SESSION_PERMISSION_MODES.map((mode) => ({
    value: mode,
    ...PERMISSION_MODE_INFO[mode],
    dangerous: DANGEROUS_PERMISSION_MODES.includes(mode),
  }));
  protected readonly keepsStored = keepsStored;
  protected readonly chosenIds = computed(
    () => new Set(this.draft().repositories.map((entry) => entry.repositoryId)),
  );

  ngOnInit(): void {
    const environment = this.environment();
    if (environment) {
      this.draft.set(draftOf(environment));
      for (const repository of environment.repositories) {
        this.loadBranches(repository.repositoryId);
      }
    }
    this.modelsStore.load();
    this.repositoriesApi.list().subscribe({
      next: ({ repositories }) => this.repositories.set(repositories),
      error: () => undefined,
    });
  }

  protected problem(field: string): string | null {
    return this.attempted() ? (this.problems().get(field) ?? null) : null;
  }

  protected change(patch: Partial<EnvironmentDraft>): void {
    this.draft.update((draft) => ({ ...draft, ...patch }));
  }

  protected addVariable(): void {
    this.change({ variables: [...this.draft().variables, newEntry()] });
  }

  protected addFile(): void {
    this.change({ files: [...this.draft().files, newEntry()] });
  }

  protected removeEntry(list: 'variables' | 'files', key: number): void {
    this.change({
      [list]: this.draft()[list].filter((entry) => entry.key !== key),
    });
  }

  protected updateEntry(
    list: 'variables' | 'files',
    key: number,
    patch: Partial<EntryDraft>,
  ): void {
    this.change({
      [list]: this.draft()[list].map((entry) =>
        entry.key === key ? { ...entry, ...patch } : entry,
      ),
    });
  }

  /**
   * Switches the secret flag. A stored secret turned into a plain value
   * needs the value typed again: the server never gives it out.
   */
  protected toggleSecret(
    list: 'variables' | 'files',
    entry: EntryDraft,
    secret: boolean,
  ): void {
    this.updateEntry(list, entry.key, {
      secret,
      ...(entry.stored && !secret ? { replacing: true, value: '' } : {}),
    });
  }

  protected replace(list: 'variables' | 'files', entry: EntryDraft): void {
    this.updateEntry(list, entry.key, { replacing: true, value: '' });
  }

  protected keep(list: 'variables' | 'files', entry: EntryDraft): void {
    this.updateEntry(list, entry.key, {
      replacing: false,
      secret: true,
      value: '',
    });
  }

  protected addRepository(): void {
    this.change({
      repositories: [...this.draft().repositories, newRepository()],
    });
  }

  protected removeRepository(key: number): void {
    this.change({
      repositories: this.draft().repositories.filter(
        (entry) => entry.key !== key,
      ),
    });
  }

  protected chooseRepository(key: number, repositoryId: string): void {
    this.change({
      repositories: this.draft().repositories.map((entry) =>
        entry.key === key ? { ...entry, repositoryId, baseBranch: '' } : entry,
      ),
    });
    this.loadBranches(repositoryId);
  }

  protected chooseBaseBranch(key: number, baseBranch: string): void {
    this.change({
      repositories: this.draft().repositories.map((entry) =>
        entry.key === key ? { ...entry, baseBranch } : entry,
      ),
    });
  }

  protected branchOptions(repositoryId: string): string[] {
    return this.branches().get(repositoryId)?.branches ?? [];
  }

  protected defaultLabel(repositoryId: string): string {
    const known =
      this.branches().get(repositoryId)?.defaultBranch ??
      this.repositories().find((repository) => repository.id === repositoryId)
        ?.defaultBranch;
    return known ? `Default (${known})` : 'Default branch';
  }

  protected save(): void {
    this.attempted.set(true);
    if (this.problems().size > 0 || this.saving()) {
      return;
    }
    const request = saveRequest(this.draft());
    const existing = this.environment();
    this.saving.set(true);
    this.error.set(null);
    (existing
      ? this.api.update(existing.id, request)
      : this.api.create(request)
    ).subscribe({
      next: (environment) => {
        this.saving.set(false);
        this.saved.emit(environment);
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.error.set(
          errorMessage(error, 'The environment could not be saved.'),
        );
      },
    });
  }

  private loadBranches(repositoryId: string): void {
    if (!repositoryId || this.branches().has(repositoryId)) {
      return;
    }
    this.repositoriesApi.branches(repositoryId).subscribe({
      next: (branches) =>
        this.branches.update((map) => new Map(map).set(repositoryId, branches)),
      error: () => undefined,
    });
  }
}
