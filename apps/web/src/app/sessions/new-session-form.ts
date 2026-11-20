import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
  untracked,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import {
  ATTACHMENT_MEDIA_TYPES,
  PERMISSION_MODE_INFO,
  DANGEROUS_PERMISSION_MODES,
  SESSION_PERMISSION_MODES,
  type CreateSessionRequest,
  type EnvironmentDto,
  type RepositoryBranchesResponse,
  type RepositoryDto,
  type SessionDto,
  type SessionPermissionMode,
} from '@claude-remote-manager/shared-types';
import { GitHubRepositoryPicker } from '../github/github-repository-picker';
import { AppIcon } from '../ui/icon';
import { ReferenceAutocomplete } from '../github-references/reference-autocomplete';
import { ReferenceChips } from '../github-references/reference-chips';
import { ReferenceSuggestions } from '../github-references/reference-suggestions';
import { DraftReferences } from '../github-references/draft-references';
import {
  qualifyReference,
  type ReferenceOptions,
} from '../github-references/references';
import {
  RepositoriesApi,
  errorMessage,
} from '../repositories/repositories-api';
import { ModelsStore } from './models-store';
import { AttachmentDrafts, imageFiles } from '../attachments/attachment-drafts';
import { AttachmentsApi } from '../attachments/attachments-api';
import { DraftImages } from '../attachments/draft-images';
import { MarkdownEditor } from '../markdown/markdown-editor';
import {
  FormattingToolbarPreference,
  MarkdownToolbar,
} from '../markdown/markdown-toolbar';
import { SessionsApi } from './sessions-api';
import { EnvironmentsApi } from '../environments/environments-api';

/** Permission modes offered for new sessions, in this order. */
export const PERMISSION_MODE_OPTIONS = SESSION_PERMISSION_MODES.map((mode) => ({
  value: mode,
  ...PERMISSION_MODE_INFO[mode],
  dangerous: DANGEROUS_PERMISSION_MODES.includes(mode),
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

/** Content shared to the app (share target) for a new session. */
export interface SessionPrefill {
  prompt: string;
  /** Images, uploaded like attached ones. */
  files: File[];
}

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
    AppIcon,
    MarkdownEditor,
    MarkdownToolbar,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    ReferenceChips,
    ReferenceSuggestions,
    RouterLink,
  ],
  templateUrl: './new-session-form.html',
  styleUrl: './new-session-form.scss',
})
export class NewSessionForm implements OnInit {
  private readonly sessionsApi = inject(SessionsApi);
  private readonly repositoriesApi = inject(RepositoriesApi);
  private readonly modelsStore = inject(ModelsStore);
  private readonly environmentsApi = inject(EnvironmentsApi);

  /** The session was created. */
  readonly created = output<SessionDto>();
  /** Fills in the prompt and images, e.g. from content shared to the app. */
  readonly prefill = input<SessionPrefill | null>(null);
  private readonly promptField = viewChild(MarkdownEditor);
  protected readonly toolbar = inject(FormattingToolbarPreference);

  /** Models from Claude Code; `''` stands for its default. */
  protected readonly modelOptions = computed(() =>
    this.modelsStore.models().map((option) => ({
      ...option,
      value: option.value ?? '',
    })),
  );
  protected readonly modeOptions = PERMISSION_MODE_OPTIONS;
  protected readonly modeInfo = PERMISSION_MODE_INFO;
  protected readonly dangerousModes = DANGEROUS_PERMISSION_MODES;
  protected readonly repositories = signal<RepositoryDto[]>([]);
  protected readonly repositoriesLoaded = signal(false);
  protected readonly branches = signal(
    new Map<string, RepositoryBranchesResponse>(),
  );

  protected get prompt(): string {
    return this.promptText();
  }

  protected set prompt(value: string) {
    this.promptText.set(value);
  }
  /** Images for the first message. */
  protected readonly images = new AttachmentDrafts(inject(AttachmentsApi));
  protected readonly accept = ATTACHMENT_MEDIA_TYPES.join(',');
  protected model = '';
  /** New sessions start in `auto` (the owner's choice). */
  protected permissionMode: SessionPermissionMode = 'auto';
  protected projectName = '';
  protected readonly environments = signal<EnvironmentDto[]>([]);
  /** Chosen environment; `''` for none. */
  protected readonly environmentId = signal('');
  /**
   * The user changed the workspace, model, mode or environment: the default
   * environment's presets no longer apply over it.
   */
  protected touched = false;
  protected readonly mode = signal<SessionMode>('repository');
  protected readonly choices = signal<RepositoryChoice[]>([emptyChoice()]);
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);

  protected readonly chosenIds = computed(
    () => new Set(this.choices().map((choice) => choice.repositoryId)),
  );
  /**
   * GitHub repositories chosen for the session, the main one first: `#`
   * searches them; `#12` refers to the one that has it (or the first, see
   * DraftReferences).
   */
  protected readonly githubRepositories = computed(() =>
    this.mode() === 'scratch'
      ? []
      : this.choices()
          .map((choice) =>
            this.repositories().find(
              (repository) => repository.id === choice.repositoryId,
            ),
          )
          .filter((repository) => !!repository?.github)
          .map((repository) => repository?.fullName ?? ''),
  );
  /** The prompt (bound to the editor's text). */
  protected readonly promptText = signal('');
  protected readonly references = new ReferenceAutocomplete(
    () => this.githubRepositories(),
    (value) => this.setPrompt(value),
  );
  /** Comments and diffs chosen per reference. */
  protected readonly referenceOptions = signal<
    ReadonlyMap<string, ReferenceOptions>
  >(new Map());

  /** The references of the prompt, for the chips and starting. */
  protected readonly draftReferences = new DraftReferences(
    () => this.promptText(),
    () => this.githubRepositories(),
    () => this.referenceOptions(),
  );

  constructor() {
    effect(() => {
      const prefill = this.prefill();
      if (prefill) {
        // Only the prefill is tracked, not the images it adds.
        untracked(() => {
          this.setPrompt(prefill.prompt);
          if (prefill.files.length > 0) {
            this.images.add(prefill.files);
          }
          this.focusPrompt();
        });
      }
    });
  }

  /** Puts the cursor into the prompt (e.g. for the "New session" shortcut). */
  focusPrompt(): void {
    const field = this.promptField();
    field?.focus();
    field?.contentElement.scrollIntoView?.({ block: 'center' });
  }

  ngOnInit(): void {
    this.modelsStore.load();
    this.repositoriesApi.list().subscribe({
      next: ({ repositories }) => {
        this.repositories.set(repositories);
        this.repositoriesLoaded.set(true);
        this.dropUnknownRepositories();
        if (repositories.length === 0) {
          this.setMode('project');
        }
      },
      error: () => this.repositoriesLoaded.set(true),
    });
    this.environmentsApi.list().subscribe({
      next: ({ environments }) => {
        this.environments.set(environments);
        const preset = environments.find((entry) => entry.isDefault);
        // Not over choices the user made while the list loaded.
        if (preset && !this.touched && !this.environmentId()) {
          this.chooseEnvironment(preset.id);
        }
      },
      error: () => undefined,
    });
  }

  /** The user picked an environment (see {@link chooseEnvironment}). */
  protected pickEnvironment(id: string): void {
    this.touched = true;
    this.chooseEnvironment(id);
  }

  /** The user picked a mode (see {@link setMode}). */
  protected pickMode(mode: SessionMode): void {
    this.touched = true;
    this.setMode(mode);
  }

  /**
   * Removes chosen repositories that are not registered (e.g. presets of
   * an environment whose repository was removed), once the list is known.
   */
  private dropUnknownRepositories(): void {
    const known = new Set(
      this.repositories().map((repository) => repository.id),
    );
    this.choices.update((choices) => {
      const kept = choices.filter(
        (choice) => !choice.repositoryId || known.has(choice.repositoryId),
      );
      if (kept.length === choices.length) {
        return choices;
      }
      return kept.length === 0 && this.mode() === 'repository'
        ? [emptyChoice()]
        : kept;
    });
  }

  /**
   * Chooses the session's environment and fills in its presets
   * (repositories, model, permission mode); all stay editable.
   */
  protected chooseEnvironment(id: string): void {
    this.environmentId.set(id);
    const environment = this.environments().find((entry) => entry.id === id);
    if (!environment) {
      return;
    }
    if (environment.model) {
      this.model = environment.model;
    }
    if (environment.permissionMode) {
      this.permissionMode = environment.permissionMode;
    }
    const known = new Set(
      this.repositories().map((repository) => repository.id),
    );
    const presets = environment.repositories.filter(
      (repository) =>
        !this.repositoriesLoaded() || known.has(repository.repositoryId),
    );
    if (presets.length > 0) {
      this.mode.set('repository');
      this.choices.set(
        presets.map((repository) => ({
          repositoryId: repository.repositoryId,
          baseBranch: repository.baseBranch ?? '',
        })),
      );
      for (const repository of presets) {
        this.loadBranches(repository.repositoryId);
      }
    }
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
    this.touched = true;
    this.choices.update((choices) => [...choices, emptyChoice()]);
  }

  protected removeRepository(index: number): void {
    this.touched = true;
    this.choices.update((choices) => choices.filter((_, i) => i !== index));
  }

  protected chooseRepository(index: number, repositoryId: string): void {
    this.touched = true;
    this.updateChoice(index, { repositoryId, baseBranch: '' });
    this.loadBranches(repositoryId);
  }

  private loadBranches(repositoryId: string): void {
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
    this.touched = true;
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
    this.touched = true;
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
      this.creating() ||
      this.draftReferences.unresolved()
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
    const references = this.draftReferences.requests(this.prompt.trim());
    const request: CreateSessionRequest = {
      prompt: this.prompt.trim(),
      ...(references.length > 0 ? { references } : {}),
      ...(this.images.ids().length > 0
        ? { attachmentIds: this.images.ids() }
        : {}),
      ...(this.model ? { model: this.model } : {}),
      // Always sent: the API's default (`default`) differs from the form's.
      permissionMode: this.permissionMode,
      ...(repositories.length > 0 ? { repositories } : {}),
      ...(this.mode() === 'project'
        ? { newProject: { name: this.projectName.trim() } }
        : {}),
      ...(this.mode() === 'scratch' ? { scratch: true } : {}),
      ...(this.environmentId() ? { environmentId: this.environmentId() } : {}),
    };
    this.creating.set(true);
    this.createError.set(null);
    this.sessionsApi.create(request).subscribe({
      next: (session) => {
        this.creating.set(false);
        this.setPrompt('');
        this.referenceOptions.set(new Map());
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
      return;
    }
    const field = this.promptField();
    if (field) {
      this.references.keydown(event, field);
    }
  }

  /** Typed, or the caret moved: the `#` reference may have changed. */
  protected onPromptChange(): void {
    const field = this.promptField();
    if (field) {
      this.references.update(field);
    }
  }

  protected setReferenceOptions(change: {
    key: string;
    options: ReferenceOptions;
  }): void {
    this.referenceOptions.update((options) =>
      new Map(options).set(change.key, change.options),
    );
  }

  /** The user chose which repository a `#12` means. */
  protected chooseReferenceRepository(choice: {
    number: number;
    repository: string;
  }): void {
    const field = this.promptField();
    const next = qualifyReference(
      this.prompt,
      choice.number,
      choice.repository,
      field?.selectionStart ?? this.prompt.length,
    );
    this.setPrompt(next.text);
    if (field) {
      // The tap blurred the prompt: give it the caret back.
      field.value = next.text;
      field.focus();
      field.setSelectionRange(next.caret, next.caret);
    }
  }

  private setPrompt(value: string): void {
    this.promptText.set(value);
  }

  private updateChoice(index: number, patch: Partial<RepositoryChoice>): void {
    this.choices.update((choices) =>
      choices.map((choice, i) =>
        i === index ? { ...choice, ...patch } : choice,
      ),
    );
  }
}
