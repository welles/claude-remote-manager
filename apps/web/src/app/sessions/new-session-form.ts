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
import {
  ATTACHMENT_MEDIA_TYPES,
  PERMISSION_MODE_INFO,
  SESSION_PERMISSION_MODES,
  type CreateSessionRequest,
  type RepositoryBranchesResponse,
  type RepositoryDto,
  type SessionDto,
  type SessionPermissionMode,
} from '@claude-remote-manager/shared-types';
import { GitHubRepositoryPicker } from '../github/github-repository-picker';
import {
  RepositoriesApi,
  errorMessage,
} from '../repositories/repositories-api';
import { ModelsStore } from './models-store';
import { AttachmentDrafts, imageFiles } from '../attachments/attachment-drafts';
import { AttachmentsApi } from '../attachments/attachments-api';
import { DraftImages } from '../attachments/draft-images';
import { SessionsApi } from './sessions-api';

/** Permission modes offered for new sessions, in this order. */
export const PERMISSION_MODE_OPTIONS = SESSION_PERMISSION_MODES.map((mode) => ({
  value: mode,
  ...PERMISSION_MODE_INFO[mode],
}));

/** Same rule as the API: letters, digits, `.`, `_`, `-`. */
export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/**
 * Where the session works: a main repository (or local project), a new
 * local project, or an empty scratch directory without repository.
 */
export type SessionMode = 'repository' | 'project' | 'scratch';

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
    DraftImages,
    FormsModule,
    GitHubRepositoryPicker,
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
  private readonly modelsStore = inject(ModelsStore);

  /** The session was created. */
  readonly created = output<SessionDto>();

  /** Models from Claude Code; `''` stands for its default. */
  protected readonly modelOptions = computed(() =>
    this.modelsStore.models().map((option) => ({
      ...option,
      value: option.value ?? '',
    })),
  );
  protected readonly modeOptions = PERMISSION_MODE_OPTIONS;
  protected readonly modeInfo = PERMISSION_MODE_INFO;
  protected readonly repositories = signal<RepositoryDto[]>([]);
  protected readonly repositoriesLoaded = signal(false);
  protected readonly branches = signal(
    new Map<string, RepositoryBranchesResponse>(),
  );

  protected prompt = '';
  /** Images for the first message. */
  protected readonly images = new AttachmentDrafts(inject(AttachmentsApi));
  protected readonly accept = ATTACHMENT_MEDIA_TYPES.join(',');
  protected model = '';
  protected permissionMode: SessionPermissionMode = 'default';
  protected projectName = '';
  protected readonly mode = signal<SessionMode>('repository');
  protected readonly choices = signal<RepositoryChoice[]>([emptyChoice()]);
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);

  protected readonly chosenIds = computed(
    () => new Set(this.choices().map((choice) => choice.repositoryId)),
  );

  ngOnInit(): void {
    this.modelsStore.load();
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

  protected setMode(mode: SessionMode): void {
    this.mode.set(mode);
    this.choices.update((choices) => {
      if (mode === 'scratch') {
        return [];
      }
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

  /**
   * A repository chosen from GitHub (now registered): it fills the first
   * empty slot or is added as a further repository.
   */
  protected addFromGitHub(repository: RepositoryDto): void {
    this.repositories.update((list) =>
      list.some((entry) => entry.id === repository.id)
        ? list
        : [...list, repository].sort((a, b) =>
            a.fullName.localeCompare(b.fullName),
          ),
    );
    if (this.chosenIds().has(repository.id)) {
      return;
    }
    const empty = this.choices().findIndex((choice) => !choice.repositoryId);
    if (empty < 0) {
      this.addRepository();
    }
    const index = empty < 0 ? this.choices().length - 1 : empty;
    this.chooseRepository(index, repository.id);
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
    if (
      (!this.prompt.trim() && this.images.ids().length === 0) ||
      this.images.busy() ||
      this.creating()
    ) {
      return false;
    }
    switch (this.mode()) {
      case 'scratch':
        return true;
      case 'project':
        return PROJECT_NAME_PATTERN.test(this.projectName.trim());
      default:
        return (this.choices()[0]?.repositoryId ?? '') !== '';
    }
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
      ...(this.images.ids().length > 0
        ? { attachmentIds: this.images.ids() }
        : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.permissionMode !== 'default'
        ? { permissionMode: this.permissionMode }
        : {}),
      ...(repositories.length > 0 ? { repositories } : {}),
      ...(this.mode() === 'project'
        ? { newProject: { name: this.projectName.trim() } }
        : {}),
      ...(this.mode() === 'scratch' ? { scratch: true } : {}),
    };
    this.creating.set(true);
    this.createError.set(null);
    this.sessionsApi.create(request).subscribe({
      next: (session) => {
        this.creating.set(false);
        this.prompt = '';
        this.images.clear();
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

  protected onPaste(event: ClipboardEvent): void {
    const files = imageFiles(event.clipboardData?.items ?? null);
    if (files.length > 0) {
      event.preventDefault();
      this.images.add(files);
    }
  }

  protected onPick(event: Event): void {
    const field = event.target as HTMLInputElement;
    this.images.add(imageFiles(field.files));
    field.value = '';
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
