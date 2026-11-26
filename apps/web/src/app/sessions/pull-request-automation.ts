import { AppDatePipe } from '../ui/dates';
import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
  MatSlideToggleModule,
  type MatSlideToggleChange,
} from '@angular/material/slide-toggle';
import {
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
  conflict: 'merge conflicts',
  queue: 'removal from the merge queue',
  ready: 'ready to merge',
};

/**
 * Autofix, autoclose and automerge of one open pull request: the switches,
 * what started the last run, Stop while a run goes on,
 * and what automerge waits for. Changes arrive back as session updates
 * over the WebSocket.
 */
@Component({
  selector: 'app-pull-request-automation',
  imports: [AppDatePipe, MatButtonModule, MatSlideToggleModule],
  template: `
    @let automation = pull().automation;
    <div
      class="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1"
      data-testid="pr-automation"
    >
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
      <mat-slide-toggle
        [checked]="automation.automerge.enabled"
        [disabled]="busy()"
        (change)="toggle('automerge', $event)"
        title="Merge by itself once all checks pass, the head commit is approved and no review thread is unresolved (turns autofix on)"
        data-testid="automerge-toggle"
        >Automerge</mat-slide-toggle
      >
    </div>
    @if (automation.running) {
      <p
        class="my-0.5 type-body-small text-primary"
        data-testid="autofix-running"
      >
        Autofix run going on{{ trigger() ? ' for ' + trigger() : '' }}.
        <button
          matButton
          type="button"
          [disabled]="busy()"
          (click)="stop()"
          data-testid="autofix-stop"
        >
          Stop autofix
        </button>
      </p>
    } @else if (automation.lastRunAt) {
      <p
        class="my-0.5 type-body-small text-on-surface-variant"
        data-testid="autofix-last-run"
      >
        Last autofix run {{ automation.lastRunAt | appDate }} for
        {{ trigger() }}.
      </p>
    }
    @if (automation.automerge.enabled) {
      @let automerge = automation.automerge;
      @if (automerge.held; as held) {
        <p
          class="my-0.5 type-body-small text-error"
          data-testid="automerge-held"
        >
          Automerge paused: Claude asks for your decision ({{ held.reason }}).
          Your next message lets it continue.
        </p>
      } @else if (automerge.failure) {
        <p
          class="my-0.5 type-body-small text-error"
          data-testid="automerge-failure"
        >
          GitHub refused the merge: {{ automerge.failure }}. Automerge tries
          again with the next commit, or turn it off and on.
        </p>
      } @else if (automerge.waiting) {
        <p
          class="my-0.5 type-body-small text-on-surface-variant"
          data-testid="automerge-waiting"
        >
          Automerge waits: {{ automerge.waiting }}.
        </p>
      } @else {
        <p
          class="my-0.5 type-body-small text-on-surface-variant"
          data-testid="automerge-info"
        >
          Automerge merges (rebase, else squash, else merge commit; through the
          merge queue where the base branch requires one) once all checks pass,
          nobody requests changes and no review thread is unresolved.
        </p>
      }
    }
    @if (error(); as text) {
      <p class="my-0.5 type-body-small text-error" role="alert">{{ text }}</p>
    }
  `,
})
export class PullRequestAutomation {
  private readonly api = inject(SessionsApi);

  readonly sessionId = input.required<string>();
  readonly pull = input.required<PullRequestDto>();

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly trigger = computed(() => {
    const trigger = this.pull().automation.lastTrigger;
    return trigger ? TRIGGER_LABELS[trigger] : null;
  });

  protected toggle(
    name: 'autofix' | 'autoclose' | 'automerge',
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
