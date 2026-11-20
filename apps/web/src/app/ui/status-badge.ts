import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import {
  needsUser,
  type SessionDto,
} from '@claude-remote-manager/shared-types';
import { statusLabel } from '../sessions/format';

/**
 * The five visual states of a session. Those where Claude would not go on
 * without the user stand out; those where it works by itself are quiet:
 * - `attention`: blocked on the user (approval, question, plan, failed
 *   setup), the only amber state;
 * - `idle`: ready for the next message, the user's turn (primary colour);
 * - `failed`: crashed or could not start;
 * - `running`: preparing, working on a turn, or waiting for background
 *   tasks or CI (it goes on by itself), muted;
 * - `done`: ended or archived.
 */
export type StatusKind = 'attention' | 'running' | 'failed' | 'idle' | 'done';

export function statusKind(
  session: Pick<SessionDto, 'status' | 'waitingFor'> & {
    archivedAt?: string | null;
  },
): StatusKind {
  if (needsUser(session)) {
    return 'attention';
  }
  if (session.archivedAt) {
    return 'done';
  }
  if (session.status === 'waiting' && session.waitingFor === 'background') {
    return 'running';
  }
  switch (session.status) {
    case 'preparing':
    case 'running':
      return 'running';
    case 'failed':
      return 'failed';
    case 'finished':
      return 'done';
    default:
      return 'idle';
  }
}

/** CSS class of the global `.status` badge for a kind. */
export const STATUS_KIND_CLASS: Record<StatusKind, string> = {
  attention: 'status-permission',
  running: 'status-running',
  failed: 'status-failed',
  idle: 'status-waiting',
  done: 'status-finished',
};

/**
 * A session's status as a small tag in its state's colour (see
 * `statusKind`), the same in the session list, the session view and the
 * search results.
 */
@Component({
  selector: 'app-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="status {{ kindClass() }}">{{ label() }}</span>`,
  styles: `
    :host {
      display: inline-flex;
    }
  `,
})
export class StatusBadge {
  readonly session =
    input.required<Pick<SessionDto, 'status' | 'waitingFor'>>();
  /** Replaces the status label, e.g. with what the session waits for. */
  readonly text = input<string | null>(null);

  protected readonly kindClass = computed(
    () => STATUS_KIND_CLASS[statusKind(this.session())],
  );
  protected readonly label = computed(
    () => this.text() ?? statusLabel(this.session()),
  );
}

/**
 * A round state marker for list rows: filled in the state's colour with a
 * halo when the user is on turn (needs you, ready), muted and softly
 * pulsing while running (not with reduced motion), a ring when done.
 */
@Component({
  selector: 'app-status-dot',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': '"dot-" + kind()', 'aria-hidden': 'true' },
  template: '',
  styles: `
    :host {
      display: inline-block;
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--app-status-idle);
    }
    :host(.dot-attention) {
      background: var(--app-status-attention);
      box-shadow: 0 0 0 3px var(--app-status-attention-container);
    }
    :host(.dot-idle) {
      background: var(--app-status-ready);
      box-shadow: 0 0 0 3px var(--app-status-ready-container);
    }
    :host(.dot-running) {
      background: var(--app-status-done);
    }
    :host(.dot-failed) {
      background: var(--app-status-failed);
    }
    :host(.dot-done) {
      background: transparent;
      box-shadow: inset 0 0 0 1.5px var(--app-status-done);
    }
    @media (prefers-reduced-motion: no-preference) {
      :host(.dot-running) {
        animation: pulse 2.4s var(--app-ease) infinite;
      }
    }
    @keyframes pulse {
      50% {
        opacity: 0.4;
      }
    }
  `,
})
export class StatusDot {
  readonly kind = input.required<StatusKind>();
}
