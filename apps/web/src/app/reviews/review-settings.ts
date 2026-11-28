import {
  Component,
  computed,
  effect,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule, type MatSelect } from '@angular/material/select';
import {
  DEFAULT_REVIEW_ENGINE,
  ENGINE_REVIEW_EFFORTS,
  reviewDefaultModel,
  type AgentEngineId,
  type UpdateReviewDefaultsRequest,
} from '@claude-remote-manager/shared-types';
import { EnginesStore } from '../engines/engines-store';
import { errorMessage } from '../repositories/repositories-api';
import { ModelsStore } from '../sessions/models-store';
import { Toasts } from '../ui/toasts';
import {
  EFFORT_LABELS,
  fallbackText,
  reviewModelOptions,
} from './review-labels';
import { ReviewDefaultsState, ReviewsApi } from './reviews-api';

/**
 * The app's review settings on the Settings page: the reviewer's engine
 * (only with more than one on the server), model and effort for sessions
 * that do not choose their own. The model and efforts are the engine's.
 */
@Component({
  selector: 'app-review-settings',
  host: { class: 'app-compact flex flex-col gap-4' },
  imports: [MatButtonModule, MatFormFieldModule, MatSelectModule],
  template: `
    <p class="m-0 text-on-surface-variant">
      An independent {{ several() ? 'reviewer' : 'Claude' }} reviews a session's
      changes, read-only and without the conversation, and its findings go to
      the session's agent to fix. Start it in a session's details, or turn on
      auto-review there.
    </p>
    @if (loadError(); as error) {
      <p class="m-0 text-error">{{ error }}</p>
      <button matButton type="button" (click)="load()">Retry</button>
    } @else if (defaults(); as d) {
      @if (several()) {
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>Engine</mat-label>
          <mat-select
            [value]="engine()"
            (selectionChange)="
              save(
                { engine: $event.value },
                revertSelect($event.source, engine())
              )
            "
            [disabled]="busy()"
            data-testid="review-default-engine"
          >
            @for (option of engines.engines(); track option.id) {
              <mat-option [value]="option.id">{{ option.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      }
      @if (fallback(); as text) {
        <p class="m-0 text-error" data-testid="review-default-fallback">
          {{ text }}
        </p>
      }
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Model</mat-label>
        <mat-select
          [value]="model()"
          (selectionChange)="
            save(
              { model: $event.value || null },
              revertSelect($event.source, model())
            )
          "
          [disabled]="busy()"
          data-testid="review-default-model"
        >
          @for (option of modelOptions(); track option.value) {
            <mat-option
              [value]="option.value ?? ''"
              [title]="option.description"
              >{{ option.label }}</mat-option
            >
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Effort</mat-label>
        <mat-select
          [value]="d.effort"
          (selectionChange)="
            save(
              { effort: $event.value },
              revertSelect($event.source, d.effort)
            )
          "
          [disabled]="busy()"
          data-testid="review-default-effort"
        >
          @for (effort of efforts(); track effort) {
            <mat-option [value]="effort">{{ effortLabels[effort] }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
    }
  `,
})
export class ReviewSettings implements OnInit {
  private readonly api = inject(ReviewsApi);
  private readonly models = inject(ModelsStore);
  protected readonly engines = inject(EnginesStore);
  private readonly toasts = inject(Toasts);

  protected readonly effortLabels = EFFORT_LABELS;
  private readonly state = inject(ReviewDefaultsState);
  protected readonly defaults = this.state.value;
  protected readonly loadError = computed(() =>
    this.state.error()
      ? errorMessage(
          this.state.error(),
          'The review settings could not be loaded',
        )
      : null,
  );
  protected readonly busy = signal(false);

  protected readonly several = this.engines.several;
  /** The settings' engine; Claude Code when the server does not have it. */
  protected readonly engine = computed<AgentEngineId>(() => {
    const engine = this.defaults()?.engine ?? DEFAULT_REVIEW_ENGINE;
    return this.engines.engines().some((option) => option.id === engine)
      ? engine
      : DEFAULT_REVIEW_ENGINE;
  });
  /** The chosen engine is not on the server (once its list is known). */
  protected readonly fallback = computed(() => {
    const engine = this.defaults()?.engine ?? DEFAULT_REVIEW_ENGINE;
    return engine !== this.engine() && this.engines.ready()
      ? fallbackText(engine)
      : null;
  });
  /** The engine's model, `''` for its default. */
  protected readonly model = computed(() => {
    const defaults = this.defaults();
    return (defaults && reviewDefaultModel(defaults, this.engine())) ?? '';
  });
  protected readonly efforts = computed(
    () => ENGINE_REVIEW_EFFORTS[this.engine()],
  );

  protected readonly modelOptions = computed(() =>
    reviewModelOptions(
      this.models.models(this.engine()),
      this.model() || null,
      this.engine(),
    ),
  );

  constructor() {
    // The models of the chosen engine (each list loads once).
    effect(() => this.models.load(this.engine()));
  }

  ngOnInit(): void {
    this.engines.load();
    this.load();
  }

  protected load(): void {
    this.state.load();
  }

  /** Puts a select back to `value` (after a failed save). */
  protected revertSelect(select: MatSelect, value: string): () => void {
    return () => {
      select.value = value;
    };
  }

  /** Saves a change; `revert` puts its control back if that fails. */
  protected save(
    request: UpdateReviewDefaultsRequest,
    revert: () => void,
  ): void {
    this.busy.set(true);
    this.api.updateDefaults(request).subscribe({
      next: (defaults) => {
        this.busy.set(false);
        this.state.value.set(defaults);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        revert();
        this.toasts.show({
          title: errorMessage(error, 'The review settings could not be saved'),
          kind: 'error',
        });
      },
    });
  }
}
