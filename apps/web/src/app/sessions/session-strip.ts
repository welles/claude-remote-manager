import { Component, computed, input, output } from '@angular/core';
import {
  DANGEROUS_PERMISSION_MODES,
  type ContextUsage,
  type SessionDto,
} from '@claude-remote-manager/shared-types';
import { AppIcon } from '../ui/icon';
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
  imports: [AppIcon, StatusDot],
  template: `
    @let s = session();
    <button
      type="button"
      class="chip state {{ kindClass() }}"
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
        [class.high]="c.percentage >= 80"
        (click)="opened.emit('context')"
        [attr.aria-label]="'Context ' + percent() + '% used'"
        data-testid="strip-context"
      >
        <span class="meter" aria-hidden="true"
          ><span class="fill" [style.width.%]="percent()"></span></span
        >{{ percent() }}%
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
        <span class="pr-state pr-{{ state }}" data-testid="strip-pr-state">{{
          state
        }}</span>
        @if (p.automation.autofix && p.state === 'open') {
          <span class="sub">· autofix</span>
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
      [class.danger]="dangerous()"
      (click)="opened.emit('settings')"
      data-testid="strip-settings"
    >
      {{ model() }} · {{ mode() }}
    </button>
    @if (s.archivedAt) {
      <span class="app-tag">Archived</span>
    }
  `,
  styles: `
    :host {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      scrollbar-width: none;
      padding: 6px var(--app-gutter);
      margin: 0 calc(-1 * var(--app-gutter));
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container-low);
    }
    .chip {
      display: inline-flex;
      flex: none;
      align-items: center;
      gap: 6px;
      height: 28px;
      padding: 0 10px;
      border: 0;
      border-radius: var(--mat-sys-corner-small);
      background: var(--mat-sys-surface-container-high);
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      cursor: pointer;
      --app-icon-size: 14px;
    }
    .chip:hover {
      color: var(--mat-sys-on-surface);
    }
    @media (pointer: coarse) {
      .chip {
        height: 32px;
      }
    }
    .state {
      font-weight: 600;
      color: var(--mat-sys-on-surface);
    }
    .state.status-permission {
      background: var(--app-status-attention-container);
      color: var(--app-status-on-attention-container);
    }
    .state.status-waiting {
      background: var(--app-status-ready-container);
      color: var(--app-status-on-ready-container);
    }
    /* Claude goes on by itself: as quiet as the other chips. */
    .state.status-running {
      font-weight: 500;
      color: var(--mat-sys-on-surface-variant);
    }
    .state.status-failed {
      background: var(--app-status-failed-container);
      color: var(--app-status-on-failed-container);
    }
    /* Tool uses run without asking (bypass permissions). */
    .chip.danger {
      background: var(--app-status-attention-container);
      color: var(--app-status-on-attention-container);
      font-weight: 600;
    }
    .meter {
      position: relative;
      width: 24px;
      height: 4px;
      border-radius: 2px;
      background: var(--mat-sys-outline-variant);
      overflow: hidden;
    }
    .fill {
      position: absolute;
      inset: 0 auto 0 0;
      background: var(--app-status-running);
    }
    .high .fill {
      background: var(--mat-sys-error);
    }
    .pr-state {
      font-weight: 600;
    }
    .pr-open {
      color: var(--app-success);
    }
    .pr-merged {
      color: var(--app-gh-merged);
    }
    .pr-closed {
      color: var(--app-diff-del-fg);
    }
    .pr-draft {
      color: var(--mat-sys-on-surface-variant);
    }
    .sub {
      color: var(--mat-sys-on-surface-variant);
    }
    .app-tag {
      align-self: center;
    }
  `,
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
  protected readonly kindClass = computed(() => STATUS_KIND_CLASS[this.kind()]);
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
