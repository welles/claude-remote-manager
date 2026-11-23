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
  MatSlideToggleModule,
  type MatSlideToggleChange,
} from '@angular/material/slide-toggle';
import {
  REVIEW_EFFORTS,
  canResume,
  type SessionDto,
  type UpdateSessionReviewRequest,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { ModelsStore } from '../sessions/models-store';
import { Toasts } from '../ui/toasts';
import {
  EFFORT_LABELS,
  reviewModelLabel,
  reviewModelOptions,
} from './review-labels';
import { ReviewDefaultsState, ReviewsApi } from './reviews-api';

/**
 * The independent review of a session in its details: start one now (or
 * cancel the running one), auto-review, and the reviewer's model and
 * effort (the app's defaults unless chosen here).
 */
@Component({
  selector: 'app-session-review-panel',
  host: { class: 'flex flex-col gap-3', 'data-testid': 'review-panel' },
  imports: [
    MatButtonModule,
    MatFormFieldModule,
    MatSelectModule,
    MatSlideToggleModule,
  ],
  template: `
    @let s = session();
    @let review = s.review;
    <div class="flex flex-wrap items-center gap-2">
      @if (review?.running; as running) {
        <span class="flex-1 type-body-medium" data-testid="review-running"
          >{{ running.trigger === 'auto' ? 'Auto-review' : 'Review' }} runs ({{
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
              ? 'An independent Claude reviews the changes of this session; its findings go to Claude to fix'
              : 'Only sessions with repositories that can continue can be reviewed'
          "
          data-testid="review-start"
        >
          Review now
        </button>
      }
    </div>
    <mat-slide-toggle
      [checked]="review?.autoReview ?? false"
      [disabled]="busy() || !enabled()"
      (change)="toggleAuto($event)"
      data-testid="auto-review-toggle"
      >Auto-review</mat-slide-toggle
    >
    <p class="-mt-2 mb-0 hint-text" data-testid="auto-review-hint">
      After each turn that changed the diff.
      @if (review?.autoReview) {
        @if (defaults(); as d) {
          @if (review.autoRounds >= d.maxAutoRounds) {
            Paused after {{ d.maxAutoRounds }} rounds with findings until you
            write.
          } @else {
            Pauses after {{ d.maxAutoRounds }} rounds with findings in a row ({{
              review.autoRounds
            }}
            so far).
          }
        }
      }
    </p>
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
  /** Connected to the server. */
  readonly enabled = input(true);
  /** The session after a change of its review settings. */
  readonly changed = output<SessionDto>();

  protected readonly efforts = REVIEW_EFFORTS;
  protected readonly effortLabels = EFFORT_LABELS;
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

  protected toggleAuto(event: MatSlideToggleChange): void {
    this.update({ autoReview: event.checked }, () => {
      // Shows the state the server has.
      event.source.checked = this.session().review?.autoReview ?? false;
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
