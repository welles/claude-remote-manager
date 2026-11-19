import { AppDatePipe } from '../ui/dates';
import { AppIcon } from '../ui/icon';
import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
  MatSlideToggleModule,
  type MatSlideToggleChange,
} from '@angular/material/slide-toggle';
import {
  AUTOFIX_MAX_ATTEMPTS_RANGE,
  type AutofixTrigger,
  type PullRequestDto,
  type UpdatePullRequestAutomationRequest,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { SessionsApi } from './sessions-api';

export const TRIGGER_LABELS: Record<AutofixTrigger, string> = {
  ci: 'failed checks',
  review: 'review feedback',
  'ci+review': 'failed checks and review feedback',
  ready: 'ready to merge',
};

/**
 * Autofix and autoclose of one open pull request: the switches, attempts
 * and limit, what started the last run, and Stop while a run goes on.
 * Changes arrive back as session updates over the WebSocket.
 */
@Component({
  selector: 'app-pull-request-automation',
  imports: [AppDatePipe, AppIcon, MatButtonModule, MatSlideToggleModule],
  template: `
    @let automation = pull().automation;
    <div class="automation" data-testid="pr-automation">
      <mat-slide-toggle
        [checked]="automation.autofix"
        [disabled]="busy()"
        (change)="toggle('autofix', $event)"
        data-testid="autofix-toggle"
        >Autofix</mat-slide-toggle
      >
      <mat-slide-toggle
        [checked]="automation.autoclose"
        [disabled]="busy()"
        (change)="toggle('autoclose', $event)"
        data-testid="autoclose-toggle"
        >Autoclose</mat-slide-toggle
      >
      <span
        class="attempts"
        [class.limit]="automation.gaveUp"
        data-testid="autofix-attempts"
        title="Autofix runs started for this pull request, and the limit"
      >
        Attempts {{ automation.attempts }} / {{ automation.maxAttempts }}
      </span>
      <span class="limit-buttons">
        <button
          type="button"
          class="app-icon-btn"
          aria-label="Lower the attempt limit"
          [disabled]="busy() || automation.maxAttempts <= range.min"
          (click)="save({ maxAttempts: automation.maxAttempts - 1 })"
          data-testid="autofix-limit-down"
        >
          <app-icon name="minus" />
        </button>
        <button
          type="button"
          class="app-icon-btn"
          aria-label="Raise the attempt limit"
          [disabled]="busy() || automation.maxAttempts >= range.max"
          (click)="save({ maxAttempts: automation.maxAttempts + 1 })"
          data-testid="autofix-limit-up"
        >
          <app-icon name="plus" />
        </button>
      </span>
      @if (automation.attempts > 0) {
        <button
          matButton="outlined"
          type="button"
          [disabled]="busy()"
          (click)="save({ resetAttempts: true })"
          data-testid="autofix-reset"
        >
          Reset count
        </button>
      }
    </div>
    @if (automation.running) {
      <p class="note running" data-testid="autofix-running">
        Autofix run going on{{ trigger() ? ' for ' + trigger() : '' }}.
        <button
          matButton="outlined"
          type="button"
          [disabled]="busy()"
          (click)="stop()"
          data-testid="autofix-stop"
        >
          Stop autofix
        </button>
      </p>
    } @else if (automation.gaveUp) {
      <p class="note warn" data-testid="autofix-gave-up">
        Limit reached: autofix starts no further runs. Raise the limit or reset
        the count to continue.
      </p>
    } @else if (automation.lastRunAt) {
      <p class="note" data-testid="autofix-last-run">
        Last autofix run {{ automation.lastRunAt | appDate }} for
        {{ trigger() }}.
      </p>
    }
    @if (error(); as text) {
      <p class="note warn" role="alert">{{ text }}</p>
    }
  `,
  styles: `
    .automation {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 16px;
      padding-top: 4px;
    }
    .attempts,
    .note {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .limit-buttons {
      display: inline-flex;
      margin-left: -8px;
    }
    /* As small as the other actions of the details (touch screens keep 44 px). */
    @media (pointer: fine) {
      .limit-buttons .app-icon-btn {
        width: 32px;
        height: 32px;
      }
    }
    .note {
      margin: 2px 0;
    }
    .running {
      color: var(--mat-sys-primary);
    }
    .warn,
    .limit {
      color: var(--mat-sys-error);
    }
  `,
})
export class PullRequestAutomation {
  private readonly api = inject(SessionsApi);

  readonly sessionId = input.required<string>();
  readonly pull = input.required<PullRequestDto>();

  protected readonly range = AUTOFIX_MAX_ATTEMPTS_RANGE;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly trigger = computed(() => {
    const trigger = this.pull().automation.lastTrigger;
    return trigger ? TRIGGER_LABELS[trigger] : null;
  });

  protected toggle(
    name: 'autofix' | 'autoclose',
    event: MatSlideToggleChange,
  ): void {
    this.save({ [name]: event.checked }, () => {
      // Not changed: show the switch as it is.
      event.source.checked = !event.checked;
    });
  }

  protected save(
    request: UpdatePullRequestAutomationRequest,
    failed?: () => void,
  ): void {
    this.run(
      this.api.updateAutomation(this.sessionId(), this.pull().id, request),
      'The automation could not be changed.',
      failed,
    );
  }

  protected stop(): void {
    this.run(
      this.api.stopAutofix(this.sessionId()),
      'The autofix run could not be stopped.',
    );
  }

  private run(
    request: ReturnType<SessionsApi['stopAutofix']>,
    fallback: string,
    failed?: () => void,
  ): void {
    this.busy.set(true);
    this.error.set(null);
    request.subscribe({
      next: () => this.busy.set(false),
      error: (error: unknown) => {
        this.busy.set(false);
        failed?.();
        this.error.set(errorMessage(error, fallback));
      },
    });
  }
}
