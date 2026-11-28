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
  DEFAULT_ENGINE,
  ENGINE_DEFAULT_PERMISSION_MODE,
  ENGINE_PROVIDERS,
  ACCOUNT_PROVIDER_LABELS,
  type AgentEngineId,
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
import { AccountsStore } from '../accounts/accounts-store';
import { EnginesStore, agentName } from '../engines/engines-store';
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

/** The choices of permission modes, in the engine's order. */
export function permissionModeOptions(
  modes: readonly SessionPermissionMode[],
): {
  value: SessionPermissionMode;
  label: string;
  description: string;
  dangerous: boolean;
}[] {
  return modes.map((mode) => ({
    value: mode,
    ...PERMISSION_MODE_INFO[mode],
    dangerous: DANGEROUS_PERMISSION_MODES.includes(mode),
  }));
}

/**
 * The mode new sessions of an engine start in: Claude Code's in `auto`
 * (the owner's choice), the others in their engine's default.
 */
export function initialPermissionMode(
  engine: AgentEngineId,
): SessionPermissionMode {
  return engine === 'claude-code'
    ? 'auto'
    : ENGINE_DEFAULT_PERMISSION_MODE[engine];
}

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
})
export class NewSessionForm implements OnInit {
  private readonly sessionsApi = inject(SessionsApi);
  private readonly repositoriesApi = inject(RepositoriesApi);
  private readonly modelsStore = inject(ModelsStore);
  private readonly accountsStore = inject(AccountsStore);
  protected readonly enginesStore = inject(EnginesStore);
  /** The engine the session runs with; chosen only with several. */
  protected readonly engine = signal<AgentEngineId>(DEFAULT_ENGINE);
  private readonly provider = computed(() => ENGINE_PROVIDERS[this.engine()]);
  protected readonly providerLabel = computed(
    () => ACCOUNT_PROVIDER_LABELS[this.provider()],
  );
  /** "Claude", "Codex": the agent the prompt is for. */
  protected readonly agent = computed(() => agentName(this.engine()));
  /** The engine's accounts; the choice only shows with more than one. */
  protected readonly accounts = computed(() => {
    this.accountsStore.accounts();
    return this.accountsStore.ofProvider(this.provider());
  });
  /** The engine's provider has no account yet (once the list is known). */
  protected readonly noAccount = computed(
    () =>
      this.accountsStore.accounts() !== null && this.accounts().length === 0,
  );
  protected readonly defaultAccountName = computed(() => {
    this.accountsStore.accounts();
    return this.accountsStore.defaultOf(this.provider())?.name ?? null;
  });
  private readonly environmentsApi = inject(EnvironmentsApi);

  /** The session was created. */
  readonly created = output<SessionDto>();
  /** Fills in the prompt and images, e.g. from content shared to the app. */
  readonly prefill = input<SessionPrefill | null>(null);
  private readonly promptField = viewChild(MarkdownEditor);
  protected readonly toolbar = inject(FormattingToolbarPreference);

  /** The engine's models; `''` stands for its default. */
  protected readonly modelOptions = computed(() =>
    this.modelsStore.models(this.engine()).map((option) => ({
      ...option,
      value: option.value ?? '',
    })),
  );
  /** The engine's permission modes. */
  protected readonly modeOptions = computed(() =>
    permissionModeOptions(
      this.enginesStore.capabilities(this.engine()).permissionModes,
    ),
  );
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
  /**
   * Chosen account; `''`: the default one (or, while its limit is
   * exhausted, the next one that is not; decided by the server).
   */
  protected accountId = '';
  /** See {@link initialPermissionMode}. */
  protected permissionMode: SessionPermissionMode =
    initialPermissionMode(DEFAULT_ENGINE);
  protected projectName = '';
  protected readonly environments = signal<EnvironmentDto[]>([]);
  /** Chosen environment; `''` for none. */
  protected readonly environmentId = signal('');
  /**
   * The user changed the workspace, model, mode or environment: the default
   * environment's presets no longer apply over it.
   */
  protected touched = false;
  /** The user picked the engine: an environment no longer changes it. */
  private enginePicked = false;
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
    // An environment chosen before the engines were known: its engine once
    // they are.
    effect(() => {
      if (!this.enginesStore.ready()) {
        return;
      }
      untracked(() => {
        const environment = this.environments().find(
          (entry) => entry.id === this.environmentId(),
        );
        if (environment && environment.presetEngine !== this.engine()) {
          const before = this.engine();
          this.applyPresetEngine(environment);
          if (this.engine() !== before) {
            this.applyAgentPresets();
          }
        }
      });
    });
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
    this.enginesStore.load();
    this.accountsStore.start();
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

  /**
   * The user picked an engine: the account, model and permission mode
   * follow it (its default account, model and mode, or the environment's
   * presets for it).
   */
  protected pickEngine(engine: AgentEngineId): void {
    if (engine === this.engine()) {
      return;
    }
    this.touched = true;
    this.enginePicked = true;
    this.setEngine(engine);
    this.applyAgentPresets();
  }

  /** Switches the engine; account, model and mode start at its defaults. */
  private setEngine(engine: AgentEngineId): void {
    this.engine.set(engine);
    this.modelsStore.load(engine);
    this.accountId = '';
    this.model = '';
    this.permissionMode = initialPermissionMode(engine);
  }

  /**
   * Preselects the environment's engine if this server has it and the
   * user did not pick one.
   */
  private applyPresetEngine(environment: EnvironmentDto): void {
    const engine = environment.presetEngine;
    if (
      !engine ||
      this.enginePicked ||
      engine === this.engine() ||
      !this.enginesStore.engines().some((entry) => entry.id === engine)
    ) {
      return;
    }
    this.setEngine(engine);
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
   * (repositories, engine, and the model and permission mode for the
   * engine); all stay editable.
   */
  protected chooseEnvironment(id: string): void {
    this.environmentId.set(id);
    const environment = this.environments().find((entry) => entry.id === id);
    if (!environment) {
      return;
    }
    this.applyPresetEngine(environment);
    this.applyAgentPresets();
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

  /** The chosen environment's model and mode for the session's engine. */
  private applyAgentPresets(): void {
    const environment = this.environments().find(
      (entry) => entry.id === this.environmentId(),
    );
    // Older servers send no presets.
    const presets = environment?.presets?.[this.engine()];
    if (!presets) {
      return;
    }
    if (presets.model) {
      this.model = presets.model;
    }
    if (
      presets.permissionMode &&
      this.enginesStore
        .capabilities(this.engine())
        .permissionModes.includes(presets.permissionMode)
    ) {
      this.permissionMode = presets.permissionMode;
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
      this.noAccount() ||
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
      ...(this.accountId ? { accountId: this.accountId } : {}),
      // Named whenever there is a choice; a server with one engine gets
      // the requests it always got.
      ...(this.enginesStore.several() || this.engine() !== DEFAULT_ENGINE
        ? { engine: this.engine() }
        : {}),
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
