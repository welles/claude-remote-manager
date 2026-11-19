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

/**
 * The CI checks of a pull request's head commit: one line with the state
 * of all of them and the counts, which opens the list of single checks
 * (state, name, link to the details). Updates arrive as session updates.
 */
@Component({
  selector: 'app-pull-request-checks',
  imports: [AppIcon],
  template: `
    @let all = checks();
    <button
      type="button"
      class="summary state-{{ overall() ?? 'none' }}"
      [attr.aria-expanded]="all.checks.length > 0 ? open() : null"
      [disabled]="all.checks.length === 0"
      (click)="open.set(!open())"
      data-testid="pr-checks-summary"
    >
      @if (overall(); as state) {
        <app-icon class="state-icon" [name]="icons[state]" />
      }
      <span class="text">{{ summary() }}</span>
      @if (all.checks.length > 0) {
        <app-icon
          class="chevron"
          [name]="open() ? 'chevron-down' : 'chevron-right'"
        />
      }
    </button>
    @if (open() && all.checks.length > 0) {
      <ul class="list" data-testid="pr-checks-list">
        @for (check of all.checks; track $index) {
          <li class="state-{{ check.state }}" data-testid="pr-check">
            <app-icon
              class="state-icon"
              [name]="icons[check.state]"
              [attr.aria-label]="labels[check.state]"
              role="img"
            />
            @if (check.url) {
              <a [href]="check.url" target="_blank" rel="noopener noreferrer">{{
                check.name
              }}</a>
            } @else {
              <span>{{ check.name }}</span>
            }
            <span class="label">{{ labels[check.state] }}</span>
          </li>
        }
      </ul>
    }
  `,
  styles: `
    :host {
      display: block;
      --app-icon-size: 16px;
      --app-icon-stroke: 2.2;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .summary {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      min-height: 28px;
      padding: 0;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .summary:disabled {
      cursor: default;
    }
    .summary:not(:disabled):hover .text {
      text-decoration: underline;
    }
    .list {
      list-style: none;
      margin: 2px 0 0;
      padding: 0 0 0 4px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .list li {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .list a,
    .list li > span:not(.label) {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--mat-sys-on-surface);
    }
    .label {
      flex: none;
    }
    .state-success .state-icon,
    .state-neutral .state-icon {
      color: var(--app-success);
    }
    .state-failure .state-icon {
      color: var(--mat-sys-error);
    }
    .state-pending .state-icon {
      color: var(--app-status-attention);
    }
    .summary.state-failure .text {
      color: var(--mat-sys-error);
    }
    @media (prefers-reduced-motion: no-preference) {
      .state-pending .state-icon {
        animation: pulse 1.6s ease-in-out infinite;
      }
    }
    @keyframes pulse {
      50% {
        opacity: 0.35;
      }
    }
  `,
})
export class PullRequestChecks {
  readonly checks = input.required<PullRequestChecksDto>();

  protected readonly icons = CHECK_STATE_ICONS;
  protected readonly labels = CHECK_STATE_LABELS;
  protected readonly open = signal(false);
  protected readonly overall = computed(() => overallCheckState(this.checks()));
  protected readonly summary = computed(() => checksSummary(this.checks()));
}
