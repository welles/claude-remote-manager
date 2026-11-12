import { TextFieldModule } from '@angular/cdk/text-field';
import {
  Component,
  computed,
  inject,
  output,
  signal,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import type {
  CreateSessionRequest,
  RepositoryBranchesResponse,
  RepositoryDto,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import {
  RepositoriesApi,
  errorMessage,
} from '../repositories/repositories-api';
import { SessionsApi } from './sessions-api';

/** Models offered for new sessions; the empty value uses Claude Code's default. */
export const MODEL_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

/** Same rule as the API: letters, digits, `.`, `_`, `-`. */
export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** A repository of the new session; `baseBranch: ''` uses the default. */
export interface RepositoryChoice {
  repositoryId: string;
  baseBranch: string;
}

const emptyChoice = (): RepositoryChoice => ({
  repositoryId: '',
  baseBranch: '',
});

/**
 * Form for a new session: the prompt, where the session works (a main
 * repository or a new project, plus further repositories, each optionally
 * with a base branch) and the model.
 */
@Component({
  selector: 'app-new-session-form',
  imports: [
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    RouterLink,
    TextFieldModule,
  ],
  templateUrl: './new-session-form.html',
  styleUrl: './new-session-form.scss',
})
export class NewSessionForm implements OnInit {
  private readonly sessionsApi = inject(SessionsApi);
  private readonly repositoriesApi = inject(RepositoriesApi);

  /** The session was created. */
  readonly created = output<SessionDto>();

  protected readonly modelOptions = MODEL_OPTIONS;
  protected readonly repositories = signal<RepositoryDto[]>([]);
  protected readonly repositoriesLoaded = signal(false);
  protected readonly branches = signal(
    new Map<string, RepositoryBranchesResponse>(),
  );

  protected prompt = '';
  protected model = '';
  protected projectName = '';
  protected readonly mode = signal<'repository' | 'project'>('repository');
  protected readonly choices = signal<RepositoryChoice[]>([emptyChoice()]);
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);

  protected readonly chosenIds = computed(
    () => new Set(this.choices().map((choice) => choice.repositoryId)),
  );

  ngOnInit(): void {
    this.repositoriesApi.list().subscribe({
      next: ({ repositories }) => {
        this.repositories.set(repositories);
        this.repositoriesLoaded.set(true);
        if (repositories.length === 0) {
          this.setMode('project');
        }
      },
      error: () => this.repositoriesLoaded.set(true),
    });
  }

  protected setMode(mode: 'repository' | 'project'): void {
    this.mode.set(mode);
    this.choices.update((choices) => {
      const chosen = choices.filter((choice) => choice.repositoryId);
      return mode === 'repository' && chosen.length === 0
        ? [emptyChoice()]
        : chosen;
    });
  }

  protected addRepository(): void {
    this.choices.update((choices) => [...choices, emptyChoice()]);
  }

  protected removeRepository(index: number): void {
    this.choices.update((choices) => choices.filter((_, i) => i !== index));
  }

  protected chooseRepository(index: number, repositoryId: string): void {
    this.updateChoice(index, { repositoryId, baseBranch: '' });
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

  protected chooseBaseBranch(index: number, baseBranch: string): void {
    this.updateChoice(index, { baseBranch });
  }

  /** Label of the default base branch of a chosen repository. */
  protected defaultLabel(repositoryId: string): string {
    const known =
      this.branches().get(repositoryId)?.defaultBranch ??
      this.repositories().find((repository) => repository.id === repositoryId)
        ?.defaultBranch;
    return known ? `Default (${known})` : 'Default branch';
  }

  protected branchOptions(repositoryId: string): string[] {
    return this.branches().get(repositoryId)?.branches ?? [];
  }

  protected canStart(): boolean {
    if (!this.prompt.trim() || this.creating()) {
      return false;
    }
    return this.mode() === 'project'
      ? PROJECT_NAME_PATTERN.test(this.projectName.trim())
      : this.choices()[0]?.repositoryId !== '';
  }

  protected create(): void {
    if (!this.canStart()) {
      return;
    }
    const repositories = this.choices()
      .filter((choice) => choice.repositoryId)
      .map((choice) => ({
        repositoryId: choice.repositoryId,
        ...(choice.baseBranch ? { baseBranch: choice.baseBranch } : {}),
      }));
    const request: CreateSessionRequest = {
      prompt: this.prompt.trim(),
      ...(this.model ? { model: this.model } : {}),
      ...(repositories.length > 0 ? { repositories } : {}),
      ...(this.mode() === 'project'
        ? { newProject: { name: this.projectName.trim() } }
        : {}),
    };
    this.creating.set(true);
    this.createError.set(null);
    this.sessionsApi.create(request).subscribe({
      next: (session) => {
        this.creating.set(false);
        this.prompt = '';
        this.projectName = '';
        this.created.emit(session);
      },
      error: (error: unknown) => {
        this.creating.set(false);
        this.createError.set(
          errorMessage(error, 'The session could not be started.'),
        );
      },
    });
  }

  protected onPromptKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.create();
    }
  }

  private updateChoice(index: number, patch: Partial<RepositoryChoice>): void {
    this.choices.update((choices) =>
      choices.map((choice, i) =>
        i === index ? { ...choice, ...patch } : choice,
      ),
    );
  }
}
