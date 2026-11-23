import {
  Component,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule, type MatSelect } from '@angular/material/select';
import {
  MAX_AUTO_REVIEW_ROUNDS,
  REVIEW_EFFORTS,
  type UpdateReviewDefaultsRequest,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { ModelsStore } from '../sessions/models-store';
import { Toasts } from '../ui/toasts';
import { EFFORT_LABELS, reviewModelOptions } from './review-labels';
import { ReviewDefaultsState, ReviewsApi } from './reviews-api';

/**
 * The app's review settings on the Settings page: the reviewer's model and
 * effort for sessions that do not choose their own, and after how many
 * auto-review rounds with findings auto-review pauses.
 */
@Component({
  selector: 'app-review-settings',
  host: { class: 'app-compact flex flex-col gap-4' },
  imports: [
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    <p class="m-0 text-on-surface-variant">
      An independent Claude reviews a session's changes, read-only and without
      the conversation, and its findings go to the session's Claude to fix.
      Start it in a session's details, or turn on auto-review there.
    </p>
    @if (loadError(); as error) {
      <p class="m-0 text-error">{{ error }}</p>
      <button matButton type="button" (click)="load()">Retry</button>
    } @else if (defaults(); as d) {
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Model</mat-label>
        <mat-select
          [value]="d.model"
          (selectionChange)="
            save({ model: $event.value }, revertSelect($event.source, d.model))
          "
          [disabled]="busy()"
          data-testid="review-default-model"
        >
          @for (option of modelOptions(); track option.value) {
            <mat-option [value]="option.value" [title]="option.description">{{
              option.label
            }}</mat-option>
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
          @for (effort of efforts; track effort) {
            <mat-option [value]="effort">{{ effortLabels[effort] }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Auto-review rounds</mat-label>
        <input
          matInput
          type="number"
          min="1"
          [max]="maxRounds"
          [value]="d.maxAutoRounds"
          (change)="saveRounds($event)"
          [disabled]="busy()"
          data-testid="review-default-rounds"
        />
        <mat-hint
          >Auto-review pauses after this many rounds with findings in a row,
          until you write.</mat-hint
        >
      </mat-form-field>
    }
  `,
})
export class ReviewSettings implements OnInit {
  private readonly api = inject(ReviewsApi);
  private readonly models = inject(ModelsStore);
  private readonly toasts = inject(Toasts);

  protected readonly efforts = REVIEW_EFFORTS;
  protected readonly effortLabels = EFFORT_LABELS;
  protected readonly maxRounds = MAX_AUTO_REVIEW_ROUNDS;
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

  protected readonly modelOptions = computed(() =>
    reviewModelOptions(this.models.models(), this.defaults()?.model ?? null),
  );

  ngOnInit(): void {
    this.models.load();
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

  protected saveRounds(event: Event): void {
    const input = event.target as HTMLInputElement;
    const previous = this.defaults()?.maxAutoRounds;
    const revert = () => {
      input.value = previous === undefined ? '' : String(previous);
    };
    const value = Number(input.value);
    if (Number.isInteger(value) && value >= 1 && value <= this.maxRounds) {
      this.save({ maxAutoRounds: value }, revert);
    } else {
      revert();
    }
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
