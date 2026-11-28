import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  type OnInit,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule, type MatSelect } from '@angular/material/select';
import {
  DEFAULT_REVIEW_ENGINE,
  DEFAULT_REVIEW_MODE,
  ENGINE_LABELS,
  ENGINE_REVIEW_EFFORTS,
  REVIEW_MODES,
  canResume,
  reviewDefaultModel,
  reviewEffortFor,
  type AgentEngineId,
  type SessionDto,
  type UpdateSessionReviewRequest,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { ModelsStore } from '../sessions/models-store';
import { agentName, engineOf, EnginesStore } from '../engines/engines-store';
import { Toasts } from '../ui/toasts';
import {
  EFFORT_LABELS,
  fallbackText,
  MODE_LABELS,
  reviewModelLabel,
  reviewModelOptions,
  triggerLabel,
} from './review-labels';
import { ReviewDefaultsState, ReviewsApi } from './reviews-api';

/**
 * The independent review of a session in its details: start one now (or
 * cancel the running one), when reviews start by themselves (the review
 * mode), and the reviewer's engine (with more than one on the server),
 * model and effort (the app's defaults unless chosen here). The model and
 * efforts are those of the reviewer's engine.
 */
@Component({
  selector: 'app-session-review-panel',
  host: { class: 'flex flex-col gap-3', 'data-testid': 'review-panel' },
  imports: [MatButtonModule, MatFormFieldModule, MatSelectModule],
  template: `
    @let s = session();
    @let review = s.review;
    <div class="flex flex-wrap items-center gap-2">
      @if (review?.running; as running) {
        <span class="flex-1 type-body-medium" data-testid="review-running"
          >{{ triggerLabel(running.trigger, agent()) }} runs ({{
            several() ? engineLabels[running.engine] + ', ' : ''
          }}{{ runningModel(running.engine, running.model) }})…</span
        >
        <button
          matButton
          type="button"
          (click)="cancel()"
          [disabled]="busy()"
          data-testid="review-cancel-panel"
        >
          Cancel
        </button>
      } @else {
        <button
          matButton="tonal"
          type="button"
          (click)="start()"
          [disabled]="busy() || !reviewable()"
          [title]="
            reviewable()
              ? 'An independent reviewer checks the changes of this session; its findings go to ' +
                agent() +
                ' to fix'
              : 'Only sessions with repositories that can continue can be reviewed'
          "
          data-testid="review-start"
        >
          Review now
        </button>
      }
    </div>
    <mat-form-field appearance="outline" subscriptSizing="dynamic">
      <mat-label>Reviews start</mat-label>
      <mat-select
        [value]="review?.mode ?? defaultMode"
        (selectionChange)="
          update(
            { mode: $event.value },
            revertSelect($event.source, review?.mode ?? defaultMode)
          )
        "
        [disabled]="busy() || !enabled()"
        data-testid="review-mode-select"
      >
        @for (mode of modes; track mode) {
          <mat-option [value]="mode" [title]="modeLabels[mode].hint">{{
            modeLabels[mode].label
          }}</mat-option>
        }
      </mat-select>
      <mat-hint data-testid="review-mode-hint"
        >{{ modeLabels[review?.mode ?? defaultMode].hint }}
      </mat-hint>
    </mat-form-field>
    @if (several()) {
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Reviewer engine</mat-label>
        <mat-select
          [value]="review?.engine ?? ''"
          (selectionChange)="
            update(
              { engine: $event.value || null },
              revertSelect($event.source, review?.engine ?? '')
            )
          "
          [disabled]="busy() || !enabled()"
          data-testid="review-engine-select"
        >
          <mat-option value=""
            >App default{{
              defaults() ? ' (' + engineLabels[defaultEngine()] + ')' : ''
            }}</mat-option
          >
          @for (option of engines.engines(); track option.id) {
            <mat-option [value]="option.id">{{ option.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
    }
    @if (fallback(); as text) {
      <p class="m-0 text-error type-body-small" data-testid="review-fallback">
        {{ text }}
      </p>
    }
    <mat-form-field appearance="outline" subscriptSizing="dynamic">
      <mat-label>Reviewer model</mat-label>
      <mat-select
        [value]="sessionModel() ?? ''"
        (selectionChange)="
          update(
            { model: $event.value || null },
            revertSelect($event.source, sessionModel() ?? '')
          )
        "
        [disabled]="busy() || !enabled()"
        data-testid="review-model-select"
      >
        <mat-option value=""
          >App default{{
            defaults() ? ' (' + modelLabel(defaultModel()) + ')' : ''
          }}</mat-option
        >
        @for (option of modelOptions(); track option.value) {
          <mat-option [value]="option.value" [title]="option.description">{{
            option.label
          }}</mat-option>
        }
      </mat-select>
    </mat-form-field>
    <mat-form-field appearance="outline" subscriptSizing="dynamic">
      <mat-label>Reviewer effort</mat-label>
      <mat-select
        [value]="review?.effort ?? ''"
        (selectionChange)="
          update(
            { effort: $event.value || null },
            revertSelect($event.source, review?.effort ?? '')
          )
        "
        [disabled]="busy() || !enabled()"
        data-testid="review-effort-select"
      >
        <mat-option value=""
          >App default{{
            defaults() ? ' (' + effortLabels[defaultEffort()] + ')' : ''
          }}</mat-option
        >
        @for (effort of efforts(); track effort) {
          <mat-option [value]="effort">{{ effortLabels[effort] }}</mat-option>
        }
      </mat-select>
    </mat-form-field>
  `,
})
export class SessionReviewPanel implements OnInit {
  private readonly api = inject(ReviewsApi);
  private readonly models = inject(ModelsStore);
  protected readonly engines = inject(EnginesStore);
  private readonly toasts = inject(Toasts);

  readonly session = input.required<SessionDto>();
  /** "Claude", "Codex": the session's agent in sentences. */
  protected readonly agent = computed(() =>
    agentName(engineOf(this.session())),
  );
  /** Connected to the server. */
  readonly enabled = input(true);
  /** The session after a change of its review settings. */
  readonly changed = output<SessionDto>();

  protected readonly effortLabels = EFFORT_LABELS;
  protected readonly engineLabels = ENGINE_LABELS;
  protected readonly modes = REVIEW_MODES;
  protected readonly defaultMode = DEFAULT_REVIEW_MODE;
  protected readonly modeLabels = MODE_LABELS;
  protected readonly triggerLabel = triggerLabel;
  private readonly defaultsState = inject(ReviewDefaultsState);
  protected readonly defaults = this.defaultsState.value;
  protected readonly busy = signal(false);

  protected readonly several = this.engines.several;

  private available(engine: AgentEngineId): boolean {
    return this.engines.engines().some((option) => option.id === engine);
  }

  /** The app's engine of reviews (Claude Code when the server lacks it). */
  protected readonly defaultEngine = computed<AgentEngineId>(() => {
    const engine = this.defaults()?.engine ?? DEFAULT_REVIEW_ENGINE;
    return this.available(engine) ? engine : DEFAULT_REVIEW_ENGINE;
  });
  /** The engine the session's reviewer runs with, as the server picks it. */
  protected readonly engine = computed<AgentEngineId>(() => {
    const engine =
      this.session().review?.engine ??
      this.defaults()?.engine ??
      DEFAULT_REVIEW_ENGINE;
    return this.available(engine) ? engine : DEFAULT_REVIEW_ENGINE;
  });
  protected readonly fallback = computed(() => {
    const wanted =
      this.session().review?.engine ??
      this.defaults()?.engine ??
      DEFAULT_REVIEW_ENGINE;
    return this.engines.ready() && !this.available(wanted)
      ? fallbackText(wanted)
      : null;
  });
  protected readonly efforts = computed(
    () => ENGINE_REVIEW_EFFORTS[this.engine()],
  );
  protected readonly defaultModel = computed(() => {
    const defaults = this.defaults();
    return defaults ? reviewDefaultModel(defaults, this.engine()) : null;
  });
  protected readonly defaultEffort = computed(() =>
    reviewEffortFor(this.engine(), this.defaults()?.effort ?? 'high'),
  );

  /**
   * The session's own model; only with the engine it belongs to (not when
   * the reviewer falls back to Claude Code).
   */
  protected readonly sessionModel = computed(() => {
    const review = this.session().review;
    return review?.model &&
      (review.engine ?? DEFAULT_REVIEW_ENGINE) === this.engine()
      ? review.model
      : null;
  });
  /** The engine's models, its default among them (for labels). */
  private readonly allModels = computed(() =>
    reviewModelOptions(
      this.models.models(this.engine()),
      this.sessionModel(),
      this.engine(),
    ),
  );
  /** The choices: "App default" stands for the engine's default model. */
  protected readonly modelOptions = computed(() =>
    this.allModels().filter((option) => option.value !== null),
  );

  constructor() {
    // The models of the reviewer's engine (each list loads once).
    effect(() => this.models.load(this.engine()));
  }

  protected readonly reviewable = computed(() => {
    const session = this.session();
    return (
      this.enabled() &&
      session.status !== 'preparing' &&
      canResume(session) &&
      session.directories.some((directory) => directory.kind === 'clone')
    );
  });

  ngOnInit(): void {
    this.engines.load();
    // Fresh: the Settings page may have changed them.
    this.defaultsState.load();
  }

  /** Puts a select back to `value` (after a failed save). */
  protected revertSelect(select: MatSelect, value: string): () => void {
    return () => {
      select.value = value;
    };
  }

  protected modelLabel(model: string | null): string {
    return reviewModelLabel(this.allModels(), model);
  }

  /** A running review's model, in the terms of its engine. */
  protected runningModel(engine: AgentEngineId, model: string | null): string {
    return engine === this.engine()
      ? this.modelLabel(model)
      : (model ?? 'Default');
  }

  protected start(): void {
    this.busy.set(true);
    this.api.start(this.session().id).subscribe({
      next: () => this.busy.set(false),
      error: (error: unknown) => this.failed(error, 'No review started'),
    });
  }

  protected cancel(): void {
    this.busy.set(true);
    this.api.cancel(this.session().id).subscribe({
      next: () => this.busy.set(false),
      error: (error: unknown) =>
        this.failed(error, 'The review could not be cancelled'),
    });
  }

  protected update(
    request: UpdateSessionReviewRequest,
    onError?: () => void,
  ): void {
    this.busy.set(true);
    this.api.updateSession(this.session().id, request).subscribe({
      next: (session) => {
        this.busy.set(false);
        this.changed.emit(session);
      },
      error: (error: unknown) => {
        onError?.();
        this.failed(error, 'The review settings could not be saved');
      },
    });
  }

  private failed(error: unknown, fallback: string): void {
    this.busy.set(false);
    this.toasts.show({ title: errorMessage(error, fallback), kind: 'error' });
  }
}
