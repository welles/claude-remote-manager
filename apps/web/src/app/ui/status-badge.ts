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
 *   tasks, CI or the reset of the usage limit (it goes on by itself),
 *   muted;
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
  if (
    session.status === 'waiting' &&
    (session.waitingFor === 'background' || session.waitingFor === 'limit')
  ) {
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

/**
 * Classes of the badge for a kind (see `badge` in tailwind.css): what
 * waits for the user is toned, a running session neutral, a finished one
 * only outlined.
 */
export const STATUS_KIND_CLASS: Record<StatusKind, string> = {
  attention: 'badge tone-attention',
  running: 'badge',
  failed: 'badge tone-error',
  idle: 'badge tone-ready',
  done: 'badge badge-outline',
};

/**
 * A session's status as a small tag in its state's colour (see
 * `statusKind`), in the session details.
 */
@Component({
  selector: 'app-status-badge',
  host: { class: 'inline-flex' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span [class]="kindClass()">{{ label() }}</span>`,
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
  host: {
    class: 'state-dot inline-block',
    '[class]': 'dotClass()',
    'aria-hidden': 'true',
  },
  template: '',
})
export class StatusDot {
  readonly kind = input.required<StatusKind>();
  // `dot-<kind>` names the state for tests and tools.
  protected readonly dotClass = computed(
    () => `dot-${this.kind()} ${DOT_CLASS[this.kind()]}`,
  );
}

const DOT_CLASS: Record<StatusKind, string> = {
  attention:
    '[--tone-bg:var(--app-status-attention)] shadow-[0_0_0_3px_var(--app-status-attention-container)]',
  idle: '[--tone-bg:var(--app-status-ready)] shadow-[0_0_0_3px_var(--app-status-ready-container)]',
  running:
    '[--tone-bg:var(--app-status-idle)] opacity-60 motion-safe:animate-pulse-soft',
  failed: '[--tone-bg:var(--app-status-failed)]',
  done: '[--tone-bg:transparent] shadow-[inset_0_0_0_1.5px_var(--app-status-done)]',
};
