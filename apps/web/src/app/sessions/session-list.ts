import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import {
  ActivatedRoute,
  Router,
  RouterLink,
  convertToParamMap,
} from '@angular/router';
import {
  canResume,
  isActiveDirectory,
  needsUser,
  type SessionDto,
} from '@claude-remote-manager/shared-types';
import { LimitsIndicator } from '../limits/limits-indicator';
import { AppDatePipe } from '../ui/dates';
import { AppIcon } from '../ui/icon';
import { AppPageBar } from '../ui/page-bar';
import {
  StatusDot,
  STATUS_KIND_CLASS,
  statusKind,
  type StatusKind,
} from '../ui/status-badge';
import { formatCost, formatTokens, needLabel, totalTokens } from './format';
import { ModelsStore, modelLabel } from './models-store';
import { EnginesStore, engineOf } from '../engines/engines-store';
import { loadSessionList, saveSessionList } from './session-list-cache';
import { SessionSearch } from './session-search';
import { SessionSocket } from './session-socket';
import { SessionsApi } from './sessions-api';

/** What the list shows: all current sessions, a part of them, or the archive. */
export type SessionFilter = 'all' | 'waiting' | 'running' | 'archived';

interface SessionGroup {
  key: string;
  label: string;
  sessions: SessionDto[];
}

const RUNNING = new Set(['preparing', 'running']);

/** Working: preparing, on a turn, or on background tasks Claude started. */
function active(session: SessionDto): boolean {
  return RUNNING.has(session.status) || session.waitingFor === 'background';
}

/**
 * Start page: the sessions, grouped by what they need (needs you, ready,
 * running, recent), with search and filters; "New session" leads to `/new`. Query
 * parameters (app shortcuts, links): `waiting` shows only sessions that
 * need the user (open approval, question, plan or failed setup; the same
 * count as the badge), `running` only working ones, `archived` the archive.
 * `new` and `share` (older shortcuts and share targets) go on to `/new`.
 * Without a connection it shows the last known list, marked as stale.
 */
@Component({
  selector: 'app-session-list',
  host: {
    '[class]':
      "pane() ? 'flex flex-col gap-2 px-3 pb-4 [--app-gutter:12px]' : 'app-page gap-2 [--app-page-max:1320px] max-sm:pb-22'",
  },
  imports: [
    AppDatePipe,
    AppIcon,
    AppPageBar,
    LimitsIndicator,
    MatButtonModule,
    MatProgressBarModule,
    RouterLink,
    SessionSearch,
    StatusDot,
  ],
  templateUrl: './session-list.html',
})
export class SessionList implements OnInit {
  private readonly api = inject(SessionsApi);
  private readonly socket = inject(SessionSocket);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  /** Beside an open session on wide screens: compact, no app bar. */
  readonly pane = input(false);
  /** The session open beside the pane (marked in the list). */
  readonly activeId = input<string | null>(null);

  protected readonly needLabel = needLabel;
  protected readonly statusKind = statusKind;
  protected readonly kindClass = STATUS_KIND_CLASS;
  protected readonly formatCost = formatCost;
  protected readonly formatTokens = formatTokens;
  protected readonly totalTokens = totalTokens;
  private readonly modelsStore = inject(ModelsStore);
  private readonly enginesStore = inject(EnginesStore);

  /** Ticks for the relative times. */
  protected readonly now = signal(Date.now());
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  /** When the list shown was loaded, if it is the stored one (offline). */
  protected readonly staleSince = signal<string | null>(null);
  protected readonly filter = signal<SessionFilter>('all');
  protected readonly archived = computed(() => this.filter() === 'archived');
  /** A search query is entered: its results replace the list. */
  protected readonly searching = signal(false);
  protected readonly resumable = canResume;
  private readonly sessionMap = signal(new Map<string, SessionDto>());
  protected readonly sessions = computed(() =>
    [...this.sessionMap().values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    ),
  );
  protected readonly needsYouCount = computed(
    () => this.sessions().filter(needsUser).length,
  );
  protected readonly runningCount = computed(
    () => this.sessions().filter(active).length,
  );
  protected readonly shown = computed(() => {
    const sessions = this.sessions();
    switch (this.filter()) {
      case 'waiting':
        return sessions.filter(needsUser);
      case 'running':
        return sessions.filter(active);
      default:
        return sessions;
    }
  });
  /**
   * Needs you, ready (the user's turn), running, then the rest; the archive
   * and filters as one.
   */
  protected readonly groups = computed<SessionGroup[]>(() => {
    const shown = this.shown();
    if (this.filter() !== 'all') {
      return [{ key: this.filter(), label: '', sessions: shown }];
    }
    const groups: SessionGroup[] = [
      { key: 'waiting', label: 'Needs you', sessions: [] },
      { key: 'ready', label: 'Ready', sessions: [] },
      { key: 'running', label: 'Running', sessions: [] },
      { key: 'recent', label: 'Recent', sessions: [] },
    ];
    for (const session of shown) {
      const kind = statusKind(session);
      const index =
        kind === 'attention'
          ? 0
          : kind === 'idle'
            ? 1
            : active(session)
              ? 2
              : 3;
      groups[index].sessions.push(session);
    }
    return groups.filter((group) => group.sessions.length > 0);
  });

  constructor() {
    // The models of every engine in the list, for their labels.
    effect(() => {
      const engines = new Set(this.sessions().map(engineOf));
      untracked(() => {
        for (const engine of engines) {
          this.modelsStore.load(engine);
        }
      });
    });
    // The list as last loaded, for starts without a connection.
    effect(() => {
      const sessions = this.sessions();
      if (
        !this.loading() &&
        this.staleSince() === null &&
        !this.loadError() &&
        !this.archived()
      ) {
        saveSessionList(sessions);
      }
    });
  }

  ngOnInit(): void {
    const params = this.pane()
      ? convertToParamMap({})
      : this.route.snapshot.queryParamMap;
    // Older shortcuts and share redirects: starting a session is a page.
    if (params.has('new') || params.has('share')) {
      const share = params.get('share');
      void this.router.navigate(['/new'], {
        queryParams: share ? { share } : {},
        replaceUrl: true,
      });
      return;
    }
    this.filter.set(
      params.has('archived')
        ? 'archived'
        : params.has('waiting')
          ? 'waiting'
          : params.has('running')
            ? 'running'
            : 'all',
    );
    this.modelsStore.load();
    this.enginesStore.load();
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
    this.socket.connect();
    this.socket.messages$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((message) => {
        if (message.type === 'session.updated') {
          if ((message.session.archivedAt !== null) === this.archived()) {
            this.upsert(message.session);
          } else {
            this.drop(message.session.id);
          }
        } else if (message.type === 'session.deleted') {
          this.drop(message.sessionId);
        }
      });
    // Back online after showing the stored list: load the real one.
    this.socket.connectedChanges$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((open) => {
        if (open && this.staleSince() !== null) {
          this.load();
        }
      });
    this.load();
  }

  /**
   * The session's model in its engine's terms, with the engine's name
   * when the UI names engines ("Codex · GPT-5").
   */
  protected modelText(session: SessionDto): string {
    const engine = engineOf(session);
    const model = modelLabel(this.modelsStore.models(engine), session.model);
    return this.enginesStore.showEngine(engine)
      ? `${this.enginesStore.engine(engine).label} · ${model}`
      : model;
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    const archived = this.archived();
    this.api.list(archived).subscribe({
      next: ({ sessions }) => {
        if (archived !== this.archived()) {
          return; // switched meanwhile
        }
        // Keep updates that arrived while the list was loading.
        const map = new Map(sessions.map((session) => [session.id, session]));
        if (this.staleSince() === null && !this.switched) {
          for (const [id, session] of this.sessionMap()) {
            map.set(id, session);
          }
        }
        this.switched = false;
        this.staleSince.set(null);
        this.sessionMap.set(map);
        this.loading.set(false);
        this.now.set(Date.now());
      },
      error: () => {
        if (archived) {
          this.loadError.set('The archived sessions could not be loaded.');
          this.loading.set(false);
          return;
        }
        const cached = loadSessionList();
        if (cached && this.sessionMap().size === 0) {
          this.sessionMap.set(
            new Map(cached.sessions.map((session) => [session.id, session])),
          );
          this.staleSince.set(cached.savedAt);
        } else if (!cached) {
          this.loadError.set('The sessions could not be loaded.');
        }
        this.loading.set(false);
      },
    });
  }

  /** The list was switched (current/archived): do not merge the old one. */
  private switched = false;

  protected setFilter(filter: SessionFilter): void {
    const wasArchived = this.archived();
    this.filter.set(filter);
    void (this.pane()
      ? Promise.resolve()
      : this.router.navigate([], {
          queryParams: {
            waiting: filter === 'waiting' ? 1 : null,
            running: filter === 'running' ? 1 : null,
            archived: filter === 'archived' ? 1 : null,
          },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        }));
    if (wasArchived !== this.archived()) {
      this.switched = true;
      this.sessionMap.set(new Map());
      this.load();
    }
  }

  private drop(id: string): void {
    if (this.sessionMap().has(id)) {
      this.sessionMap.update((map) => {
        const next = new Map(map);
        next.delete(id);
        return next;
      });
    }
  }

  /** Repositories of a session, e.g. `acme/app + acme/lib`, or `Scratch`. */
  protected workspaceLabel(session: SessionDto): string {
    return session.directories
      .filter(isActiveDirectory)
      .map((directory) =>
        directory.kind === 'scratch'
          ? 'Scratch'
          : (directory.repository?.fullName ?? null),
      )
      .filter((name): name is string => name !== null)
      .join(' + ');
  }

  /**
   * Kinds whose state is a coloured tag (Claude would not go on without the
   * user); the others, running ones included, are plain text.
   */
  protected tagged(kind: StatusKind): boolean {
    return kind === 'attention' || kind === 'idle' || kind === 'failed';
  }

  private upsert(session: SessionDto): void {
    this.sessionMap.update((map) => new Map(map).set(session.id, session));
  }
}
