import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type { ConversationItem } from '../sessions/conversation';
import { formatCost, formatTokens, totalTokens } from '../sessions/format';
import { MarkdownPipe } from '../sessions/markdown.pipe';
import { errorMessage } from '../repositories/repositories-api';
import { AppIcon } from '../ui/icon';
import { Toasts } from '../ui/toasts';
import { ENGINE_LABELS } from '@claude-remote-manager/shared-types';
import { EnginesStore } from '../engines/engines-store';
import {
  EFFORT_LABELS,
  fallbackText,
  SEVERITY_LABELS,
  triggerLabel,
} from './review-labels';
import { ReviewsApi } from './reviews-api';

export type ReviewItem = Extract<ConversationItem, { kind: 'review' }>;

/**
 * An independent review in the conversation: running (with Cancel), its
 * findings and whether they went to the session's agent, or why it failed.
 * Names the reviewer's engine when the server has more than one, and says
 * when the chosen engine was not there.
 */
@Component({
  selector: 'app-review-card',
  host: {
    class:
      'flex flex-col gap-2 rounded-(--mat-sys-corner-small) border border-outline-variant bg-surface-container-low px-3 py-2 type-body-medium',
    'data-testid': 'review-card',
    '[attr.data-outcome]': 'state()',
  },
  imports: [
    AppIcon,
    DecimalPipe,
    MarkdownPipe,
    MatButtonModule,
    MatProgressBarModule,
  ],
  template: `
    @let review = item();
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <app-icon
        [name]="
          state() === 'finished'
            ? review.findings.length > 0
              ? 'alert'
              : 'check'
            : state() === 'running'
              ? 'eye'
              : 'alert'
        "
        [class]="
          state() === 'failed' ||
          (state() === 'finished' && review.findings.length > 0)
            ? 'text-error'
            : state() === 'finished'
              ? 'text-success'
              : 'text-on-surface-variant'
        "
      />
      <span class="font-medium">{{
        triggerLabel(review.trigger, agent())
      }}</span>
      <span class="text-on-surface-variant" data-testid="review-state">{{
        stateText()
      }}</span>
      <span class="flex-1"></span>
      @if (state() === 'running') {
        <button
          matButton
          type="button"
          (click)="cancel()"
          [disabled]="cancelling()"
          data-testid="review-cancel"
        >
          Cancel
        </button>
      }
    </div>
    @if (state() === 'running') {
      <mat-progress-bar mode="indeterminate" />
    }
    @if (review.fallbackFrom) {
      <p class="m-0 hint-text" data-testid="review-fallback">
        {{
          review.fallbackReason
            ? review.fallbackReason +
              ': this review ran with ' +
              engineLabels['claude-code'] +
              ' instead.'
            : fallbackText(review.fallbackFrom)
        }}
      </p>
    }
    <p class="m-0 hint-text" data-testid="review-meta">
      @if (engines.several() || review.engine !== 'claude-code') {
        {{ engineLabels[review.engine] ?? review.engine }} ·
      }
      {{ review.model ?? 'default model' }} · effort {{ effortLabel() }} ·
      {{ review.fileCount }}
      {{ review.fileCount === 1 ? 'file' : 'files' }}
      @if (review.repositories.length > 1) {
        in {{ review.repositories.join(', ') }}
      }
      @if (review.durationMs !== null) {
        · {{ review.durationMs / 1000 | number: '1.0-0' }} s
      }
      @if (review.usage; as usage) {
        · {{ formatTokens(totalTokens(usage)) }} tokens ·
        {{ formatCost(usage.costUsd) }}
      }
    </p>
    @if (review.summary) {
      <p class="m-0 wrap-anywhere" data-testid="review-summary">
        {{ review.summary }}
      </p>
    }
    @if (review.error) {
      <p class="m-0 text-error wrap-anywhere" data-testid="review-error">
        {{ review.error }}
      </p>
    }
    @if (review.findings.length > 0) {
      <ul class="m-0 flex list-none flex-col gap-1 p-0">
        @for (finding of review.findings; track $index) {
          <li>
            <details class="tool-row" data-testid="review-finding">
              <summary class="grid-cols-[auto_minmax(0,1fr)]!">
                <span
                  class="badge"
                  [class.tone-error]="finding.severity === 'high'"
                  [class.tone-attention]="finding.severity === 'medium'"
                  >{{ severityLabels[finding.severity] }}</span
                >
                <span class="truncate text-on-surface"
                  >{{ finding.title }}
                  @if (finding.file) {
                    <span class="type-code text-on-surface-variant"
                      >· {{ finding.file
                      }}{{
                        finding.line !== null ? ':' + finding.line : ''
                      }}</span
                    >
                  }
                </span>
              </summary>
              <div
                class="markdown px-1.5 pt-1 pb-2 wrap-anywhere"
                [innerHTML]="finding.detail | markdown"
              ></div>
            </details>
          </li>
        }
      </ul>
    }
    @if (review.messageId) {
      <p class="m-0 hint-text" data-testid="review-sent">
        The findings went to {{ agent() }} to fix.
      </p>
    }
  `,
})
export class ReviewCard {
  private readonly api = inject(ReviewsApi);
  private readonly toasts = inject(Toasts);
  protected readonly engines = inject(EnginesStore);

  readonly item = input.required<ReviewItem>();
  readonly sessionId = input.required<string>();
  /** The session's agent in sentences ("Claude", "Codex"). */
  readonly agent = input('Claude');
  /** The session's review running now, by ID (`null` without). */
  readonly runningId = input<string | null>(null);

  protected readonly severityLabels = SEVERITY_LABELS;
  protected readonly engineLabels = ENGINE_LABELS;
  protected readonly fallbackText = fallbackText;
  protected readonly triggerLabel = triggerLabel;
  protected readonly formatCost = formatCost;
  protected readonly formatTokens = formatTokens;
  protected readonly totalTokens = totalTokens;
  protected readonly cancelling = signal(false);

  /**
   * `running` while the server runs it; without an outcome and not
   * running it was cut off (the server stopped).
   */
  protected readonly state = computed(() => {
    const review = this.item();
    if (review.outcome) {
      return review.outcome;
    }
    return this.runningId() === review.reviewId ? 'running' : 'interrupted';
  });

  protected readonly stateText = computed(() => {
    const review = this.item();
    switch (this.state()) {
      case 'running':
        return 'running…';
      case 'interrupted':
        return 'interrupted';
      case 'cancelled':
        return 'cancelled';
      case 'failed':
        return 'failed';
      default:
        return review.findings.length === 0
          ? 'no findings'
          : review.findings.length === 1
            ? '1 finding'
            : `${review.findings.length} findings`;
    }
  });

  protected readonly effortLabel = computed(
    () => EFFORT_LABELS[this.item().effort] ?? this.item().effort,
  );

  protected cancel(): void {
    this.cancelling.set(true);
    this.api.cancel(this.sessionId()).subscribe({
      next: () => this.cancelling.set(false),
      error: (error: unknown) => {
        this.cancelling.set(false);
        this.toasts.show({
          title: errorMessage(error, 'The review could not be cancelled'),
          kind: 'error',
        });
      },
    });
  }
}
