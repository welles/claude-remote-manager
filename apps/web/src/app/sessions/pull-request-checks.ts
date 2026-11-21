import { Component, computed, input, signal } from '@angular/core';
import type {
  PullRequestCheckState,
  PullRequestChecksDto,
} from '@claude-remote-manager/shared-types';
import { AppIcon, type IconName } from '../ui/icon';

/** How the state of a check (and of all checks together) is drawn. */
export const CHECK_STATE_ICONS: Record<PullRequestCheckState, IconName> = {
  success: 'check',
  failure: 'close',
  pending: 'clock',
  neutral: 'check',
  skipped: 'minus',
  cancelled: 'minus',
};

export const CHECK_STATE_LABELS: Record<PullRequestCheckState, string> = {
  success: 'passed',
  failure: 'failed',
  pending: 'running',
  neutral: 'neutral',
  skipped: 'skipped',
  cancelled: 'cancelled',
};

/** Parts of the summary, in this order (neutral counts as passed). */
const SUMMARY_PARTS: [string, PullRequestCheckState[]][] = [
  ['failed', ['failure']],
  ['running', ['pending']],
  ['cancelled', ['cancelled']],
  ['passed', ['success', 'neutral']],
  ['skipped', ['skipped']],
];

/** The state of all checks together; `null` without checks. */
export function overallCheckState(
  checks: PullRequestChecksDto,
): PullRequestCheckState | null {
  const states = new Set(checks.checks.map((check) => check.state));
  if (states.size === 0) {
    return null;
  }
  for (const state of ['failure', 'pending', 'cancelled'] as const) {
    if (states.has(state)) {
      return state;
    }
  }
  return 'success';
}

/** E.g. "Checks: 1 failed, 2 running, 5 passed". */
export function checksSummary(checks: PullRequestChecksDto): string {
  if (checks.checks.length === 0) {
    return 'No checks reported';
  }
  const parts = SUMMARY_PARTS.map(([label, states]) => {
    const count = checks.checks.filter((check) =>
      states.includes(check.state),
    ).length;
    return count > 0 ? `${count} ${label}` : null;
  }).filter((part) => part !== null);
  return `Checks: ${parts.join(', ')}`;
}

let nextId = 0;

/**
 * The CI checks of a pull request's head commit: one line with the state
 * of all of them and the counts, which opens the list of single checks
 * (state, name, link to the details). Updates arrive as session updates.
 */
@Component({
  selector: 'app-pull-request-checks',
  imports: [AppIcon],
  host: {
    class:
      'block type-body-small text-on-surface-variant [--app-icon-size:16px] [--app-icon-stroke:2.2]',
  },
  template: `
    @let all = checks();
    @if (all.checks.length === 0) {
      <span
        class="inline-flex min-h-7 max-w-full items-center gap-1.5 pointer-coarse:min-h-9"
        data-testid="pr-checks-summary"
        >{{ summary() }}</span
      >
    } @else {
      <button
        type="button"
        class="group/summary inline-flex min-h-7 max-w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-inherit [font:inherit] pointer-coarse:min-h-9"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="listId"
        (click)="open.set(!open())"
        data-testid="pr-checks-summary"
      >
        @if (overall(); as state) {
          <app-icon [class]="stateClass[state]" [name]="icons[state]" />
        }
        <span
          class="group-hover/summary:underline"
          [class.text-error]="overall() === 'failure'"
          >{{ summary() }}</span
        >
        <app-icon [name]="open() ? 'chevron-down' : 'chevron-right'" />
      </button>
      @if (open()) {
        <ul
          class="mt-0.5 mb-0 flex list-none flex-col gap-0.5 py-0 pr-0 pl-1"
          [id]="listId"
          data-testid="pr-checks-list"
        >
          @for (check of all.checks; track $index) {
            <li
              class="flex min-w-0 items-center gap-1.5 pointer-coarse:min-h-9"
              data-testid="pr-check"
            >
              <app-icon
                [class]="stateClass[check.state]"
                [name]="icons[check.state]"
              />
              @if (check.url) {
                <a
                  class="min-w-0 flex-auto truncate text-on-surface"
                  [href]="check.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  >{{ check.name }}</a
                >
              } @else {
                <span class="min-w-0 flex-auto truncate text-on-surface">{{
                  check.name
                }}</span>
              }
              <span class="flex-none">{{ labels[check.state] }}</span>
            </li>
          }
        </ul>
      }
    }
  `,
})
export class PullRequestChecks {
  readonly checks = input.required<PullRequestChecksDto>();

  protected readonly icons = CHECK_STATE_ICONS;
  protected readonly labels = CHECK_STATE_LABELS;
  /** Colour of a state's icon; running checks pulse. */
  protected readonly stateClass: Record<PullRequestCheckState, string> = {
    success: 'text-success',
    neutral: 'text-success',
    failure: 'text-error',
    pending: 'text-tertiary motion-safe:animate-pulse-soft',
    skipped: '',
    cancelled: '',
  };
  protected readonly open = signal(false);
  protected readonly listId = `pr-checks-${nextId++}`;
  protected readonly overall = computed(() => overallCheckState(this.checks()));
  protected readonly summary = computed(() => checksSummary(this.checks()));
}
