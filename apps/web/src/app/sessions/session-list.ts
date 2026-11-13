import { DatePipe } from '@angular/common';
import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  type AfterViewInit,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { SessionDto } from '@claude-remote-manager/shared-types';
import { SHARE_CACHE, sharedPrompt, takeShare } from '../../sw/share-store';
import {
  formatCost,
  formatTokens,
  statusClass,
  statusLabel,
  totalTokens,
} from './format';
import { NewSessionForm, type SessionPrefill } from './new-session-form';
import { loadSessionList, saveSessionList } from './session-list-cache';
import { SessionSocket } from './session-socket';
import { SessionsApi } from './sessions-api';

/**
 * Start page: all sessions with their status, and a form for a new one.
 * Query parameters of the app shortcuts and the share target: `new` puts
 * the cursor into the form, `waiting` shows only waiting sessions, `share`
 * fills the form with content shared to the app. Without a connection it
 * shows the last known list, marked as stale.
 */
@Component({
  selector: 'app-session-list',
  imports: [
    DatePipe,
    MatButtonModule,
    MatCardModule,
    MatProgressSpinnerModule,
    NewSessionForm,
    RouterLink,
  ],
  templateUrl: './session-list.html',
  styleUrl: './session-list.scss',
})
export class SessionList implements OnInit, AfterViewInit {
  private readonly api = inject(SessionsApi);
  private readonly socket = inject(SessionSocket);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly form = viewChild(NewSessionForm);

  protected readonly statusLabel = statusLabel;
  protected readonly statusClass = statusClass;
  protected readonly formatCost = formatCost;
  protected readonly formatTokens = formatTokens;
  protected readonly totalTokens = totalTokens;

  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  /** When the list shown was loaded, if it is the stored one (offline). */
  protected readonly staleSince = signal<string | null>(null);
  protected readonly waitingOnly = signal(false);
  protected readonly prefill = signal<SessionPrefill | null>(null);
  protected readonly shareNotice = signal<string | null>(null);
  private readonly sessionMap = signal(new Map<string, SessionDto>());
  protected readonly sessions = computed(() =>
    [...this.sessionMap().values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    ),
  );
  protected readonly waitingCount = computed(
    () =>
      this.sessions().filter((session) => session.status === 'waiting').length,
  );
  protected readonly shown = computed(() =>
    this.waitingOnly()
      ? this.sessions().filter((session) => session.status === 'waiting')
      : this.sessions(),
  );

  constructor() {
    // The list as last loaded, for starts without a connection.
    effect(() => {
      const sessions = this.sessions();
      if (!this.loading() && this.staleSince() === null && !this.loadError()) {
        saveSessionList(sessions);
      }
    });
  }

  ngOnInit(): void {
    const params = this.route.snapshot.queryParamMap;
    this.waitingOnly.set(params.has('waiting'));
    const share = params.get('share');
    if (share) {
      void this.takeShare(share);
    }
    this.socket.connect();
    this.socket.messages$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((message) => {
        if (message.type === 'session.updated') {
          this.upsert(message.session);
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

  ngAfterViewInit(): void {
    if (this.route.snapshot.queryParamMap.has('new')) {
      this.form()?.focusPrompt();
    }
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api.list().subscribe({
      next: ({ sessions }) => {
        // Keep updates that arrived while the list was loading.
        const map = new Map(sessions.map((session) => [session.id, session]));
        if (this.staleSince() === null) {
          for (const [id, session] of this.sessionMap()) {
            map.set(id, session);
          }
        }
        this.staleSince.set(null);
        this.sessionMap.set(map);
        this.loading.set(false);
      },
      error: () => {
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

  protected showWaiting(on: boolean): void {
    this.waitingOnly.set(on);
    void this.router.navigate([], {
      queryParams: { waiting: on ? 1 : null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** Repositories of a session, e.g. `acme/app + acme/lib`, or `Scratch`. */
  protected workspaceLabel(session: SessionDto): string {
    return session.directories
      .map((directory) =>
        directory.kind === 'scratch'
          ? 'Scratch'
          : (directory.repository?.fullName ?? null),
      )
      .filter((name): name is string => name !== null)
      .join(' + ');
  }

  protected open(session: SessionDto): void {
    this.upsert(session);
    void this.router.navigate(['/sessions', session.id]);
  }

  private upsert(session: SessionDto): void {
    this.sessionMap.update((map) => new Map(map).set(session.id, session));
  }

  /** Content shared to the app becomes the new session's prompt and images. */
  private async takeShare(id: string): Promise<void> {
    try {
      const content =
        id !== 'failed' && 'caches' in globalThis
          ? await takeShare(await caches.open(SHARE_CACHE), id)
          : null;
      if (content) {
        this.prefill.set({
          prompt: sharedPrompt(content),
          files: content.files,
        });
        this.shareNotice.set(
          'Shared content is in the form below: choose where the session works and start it.',
        );
      } else {
        this.shareNotice.set('The shared content could not be received.');
      }
    } catch {
      this.shareNotice.set('The shared content could not be received.');
    }
    void this.router.navigate([], {
      queryParams: { share: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
