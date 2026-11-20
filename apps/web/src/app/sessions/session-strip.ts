import { Component, computed, input, output } from '@angular/core';
import {
  DANGEROUS_PERMISSION_MODES,
  type ContextUsage,
  type SessionDto,
} from '@claude-remote-manager/shared-types';
import { AppIcon } from '../ui/icon';
import { Meter } from '../ui/meter';
import { StatusDot, STATUS_KIND_CLASS, statusKind } from '../ui/status-badge';
import { needLabel } from './format';
import type { Todo } from './todos';

/** Sections of the session's details a chip of the strip leads to. */
export type DetailSection =
  | 'status'
  | 'context'
  | 'tasks'
  | 'git'
  | 'previews'
  | 'settings';

/**
 * The session at a glance, under the app bar while the conversation
 * scrolls: state (what it needs), context use, pull request, tasks,
 * previews, model and permissions. Each chip opens the details at its
 * section; the state chip of a session that needs the user goes to the
 * request at the bottom instead.
 */
@Component({
  selector: 'app-session-strip',
  imports: [AppIcon, Meter, StatusDot],
  template: `
    @let s = session();
    <button
      type="button"
      class="chip {{ toneClass() }}"
      (click)="opened.emit(kind() === 'attention' ? 'dock' : 'status')"
      data-testid="strip-state"
    >
      <app-status-dot [kind]="kind()" />
      <span data-testid="status">{{ label() }}</span>
    </button>
    @if (context(); as c) {
      <button
        type="button"
        class="chip"
        (click)="opened.emit('context')"
        [attr.aria-label]="'Context ' + percent() + '% used'"
        data-testid="strip-context"
      >
        <app-meter inline [value]="percent()" [high]="c.percentage >= 80" />{{
          percent()
        }}%
      </button>
    }
    @if (pull(); as p) {
      <button
        type="button"
        class="chip"
        (click)="opened.emit('git')"
        data-testid="strip-pr"
      >
        <app-icon name="pull-request" />#{{ p.number }}
        @let state = p.draft && p.state === 'open' ? 'draft' : p.state;
        <span class="badge tone-{{ state }}" data-testid="strip-pr-state">{{
          state
        }}</span>
        @if (p.automation.autofix && p.state === 'open') {
          autofix
        }
      </button>
    }
    @if (todos().length > 0) {
      <button
        type="button"
        class="chip"
        (click)="opened.emit('tasks')"
        data-testid="strip-tasks"
      >
        <app-icon name="check" />Tasks {{ done() }}/{{ todos().length }}
      </button>
    }
    @if (previews() > 0) {
      <button
        type="button"
        class="chip"
        (click)="opened.emit('previews')"
        data-testid="strip-previews"
      >
        <app-icon name="eye" />{{ previews() }}
        {{ previews() === 1 ? 'preview' : 'previews' }}
      </button>
    }
    <button
      type="button"
      class="chip"
      [class.tone-attention]="dangerous()"
      (click)="opened.emit('settings')"
      data-testid="strip-settings"
    >
      {{ model() }} · {{ mode() }}
    </button>
    @if (s.archivedAt) {
      <span class="badge self-center">Archived</span>
    }
  `,
  host: {
    class:
      'flex gap-1.5 overflow-x-auto [scrollbar-width:none] py-1.5 px-(--app-gutter) -mx-(--app-gutter) border-b border-outline-variant bg-surface-container-low',
  },
})
export class SessionStrip {
  readonly session = input.required<SessionDto>();
  readonly context = input<ContextUsage | null>(null);
  readonly todos = input<Todo[]>([]);
  /** Display names of the model and the permission mode. */
  readonly model = input('Default');
  readonly mode = input('');
  /** A chip was tapped: the details section, or `dock` for the request. */
  readonly opened = output<DetailSection | 'dock'>();

  protected readonly kind = computed(() => statusKind(this.session()));
  /** The process runs in a mode that asks nobody (no override in effect). */
  protected readonly dangerous = computed(() => {
    const s = this.session();
    return (
      DANGEROUS_PERMISSION_MODES.includes(s.permissionMode) &&
      !s.permissionModeOverride
    );
  });
  /** The state chip is toned like the state's badge (none while running). */
  protected readonly toneClass = computed(() =>
    STATUS_KIND_CLASS[this.kind()]
      .split(' ')
      .filter((name) => name.startsWith('tone-'))
      .join(' '),
  );
  protected readonly label = computed(() => needLabel(this.session()));
  protected readonly percent = computed(() =>
    Math.min(100, Math.round(this.context()?.percentage ?? 0)),
  );
  /** The newest open pull request, else the newest one. */
  protected readonly pull = computed(() => {
    const pulls = this.session().pullRequests;
    return (
      pulls.findLast((pull) => pull.state === 'open') ?? pulls.at(-1) ?? null
    );
  });
  protected readonly done = computed(
    () => this.todos().filter((todo) => todo.status === 'completed').length,
  );
  protected readonly previews = computed(
    () =>
      this.session().previews.filter((preview) => preview.state !== 'stopped')
        .length,
  );
}
