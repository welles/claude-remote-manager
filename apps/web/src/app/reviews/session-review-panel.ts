import {
  Component,
  computed,
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
  REVIEW_EFFORTS,
  DEFAULT_REVIEW_MODE,
  REVIEW_MODES,
  canResume,
  type SessionDto,
  type UpdateSessionReviewRequest,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { ModelsStore } from '../sessions/models-store';
import { agentName, engineOf } from '../engines/engines-store';
import { Toasts } from '../ui/toasts';
import {
  EFFORT_LABELS,
  MODE_LABELS,
  reviewModelLabel,
  reviewModelOptions,
  triggerLabel,
} from './review-labels';
import { ReviewDefaultsState, ReviewsApi } from './reviews-api';

/**
 * The independent review of a session in its details: start one now (or
 * cancel the running one), when reviews start by themselves (the review
 * mode), and the reviewer's model and effort (the app's defaults unless
 * chosen here).
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
            modelLabel(running.model)
          }})…</span
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
              ? 'An independent Claude reviews the changes of this session; its findings go to ' +
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
    <mat-form-field appearance="outline" subscriptSizing="dynamic">
      <mat-label>Reviewer model</mat-label>
      <mat-select
        [value]="review?.model ?? ''"
        (selectionChange)="
          update(
            { model: $event.value || null },
            revertSelect($event.source, review?.model ?? '')
          )
        "
        [disabled]="busy() || !enabled()"
        data-testid="review-model-select"
      >
        <mat-option value=""
          >App default{{
            defaults() ? ' (' + modelLabel(defaults()!.model) + ')' : ''
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
            defaults() ? ' (' + effortLabels[defaults()!.effort] + ')' : ''
          }}</mat-option
        >
        @for (effort of efforts; track effort) {
          <mat-option [value]="effort">{{ effortLabels[effort] }}</mat-option>
        }
      </mat-select>
    </mat-form-field>
  `,
})
export class SessionReviewPanel implements OnInit {
  private readonly api = inject(ReviewsApi);
  private readonly models = inject(ModelsStore);
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

  protected readonly efforts = REVIEW_EFFORTS;
  protected readonly effortLabels = EFFORT_LABELS;
  protected readonly modes = REVIEW_MODES;
  protected readonly defaultMode = DEFAULT_REVIEW_MODE;
  protected readonly modeLabels = MODE_LABELS;
  protected readonly triggerLabel = triggerLabel;
  private readonly defaultsState = inject(ReviewDefaultsState);
  protected readonly defaults = this.defaultsState.value;
  protected readonly busy = signal(false);

  protected readonly modelOptions = computed(() =>
    reviewModelOptions(
      this.models.models(),
      this.session().review?.model ?? null,
    ),
  );

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
    this.models.load();
    // Fresh: the Settings page may have changed them.
    this.defaultsState.load();
  }

  /** Puts a select back to `value` (after a failed save). */
  protected revertSelect(select: MatSelect, value: string): () => void {
    return () => {
      select.value = value;
    };
  }

  protected modelLabel(model: string): string {
    return reviewModelLabel(this.modelOptions(), model);
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
