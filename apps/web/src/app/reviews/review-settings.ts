import {
  Component,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import {
  MAX_AUTO_REVIEW_ROUNDS,
  REVIEW_EFFORTS,
  type ReviewDefaults,
  type UpdateReviewDefaultsRequest,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { ModelsStore } from '../sessions/models-store';
import { Toasts } from '../ui/toasts';
import { EFFORT_LABELS, reviewModelOptions } from './review-labels';
import { ReviewsApi } from './reviews-api';

/**
 * The app's review settings on the Settings page: the reviewer's model and
 * effort for sessions that do not choose their own, and after how many
 * auto-review rounds with findings auto-review pauses.
 */
@Component({
  selector: 'app-review-settings',
  host: { class: 'app-compact flex flex-col gap-4' },
  imports: [
    FormsModule,
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
          (selectionChange)="save({ model: $event.value })"
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
          (selectionChange)="save({ effort: $event.value })"
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
          [ngModel]="d.maxAutoRounds"
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
  protected readonly defaults = signal<ReviewDefaults | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly modelOptions = computed(() =>
    reviewModelOptions(this.models.models(), this.defaults()?.model ?? null),
  );

  ngOnInit(): void {
    this.models.load();
    this.load();
  }

  protected load(): void {
    this.loadError.set(null);
    this.api.defaults().subscribe({
      next: (defaults) => this.defaults.set(defaults),
      error: (error: unknown) =>
        this.loadError.set(
          errorMessage(error, 'The review settings could not be loaded'),
        ),
    });
  }

  protected saveRounds(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isInteger(value) && value >= 1 && value <= this.maxRounds) {
      this.save({ maxAutoRounds: value });
    } else {
      // Back to the stored value.
      const current = this.defaults();
      this.defaults.set(current ? { ...current } : null);
    }
  }

  protected save(request: UpdateReviewDefaultsRequest): void {
    this.busy.set(true);
    this.api.updateDefaults(request).subscribe({
      next: (defaults) => {
        this.busy.set(false);
        this.defaults.set(defaults);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        // Back to the stored values.
        const current = this.defaults();
        this.defaults.set(current ? { ...current } : null);
        this.toasts.show({
          title: errorMessage(error, 'The review settings could not be saved'),
          kind: 'error',
        });
      },
    });
  }
}
