import { DatePipe } from '@angular/common';
import {
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Router, RouterLink } from '@angular/router';
import type { SessionDto } from '@claude-remote-manager/shared-types';
import {
  formatCost,
  formatTokens,
  statusClass,
  statusLabel,
  totalTokens,
} from './format';
import { NewSessionForm } from './new-session-form';
import { SessionSocket } from './session-socket';
import { SessionsApi } from './sessions-api';

/** Start page: all sessions with their status, and a form for a new one. */
@Component({
  selector: 'app-session-list',
  imports: [
    DatePipe,
    MatCardModule,
    MatProgressSpinnerModule,
    NewSessionForm,
    RouterLink,
  ],
  templateUrl: './session-list.html',
  styleUrl: './session-list.scss',
})
export class SessionList implements OnInit {
  private readonly api = inject(SessionsApi);
  private readonly socket = inject(SessionSocket);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly statusLabel = statusLabel;
  protected readonly statusClass = statusClass;
  protected readonly formatCost = formatCost;
  protected readonly formatTokens = formatTokens;
  protected readonly totalTokens = totalTokens;

  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  private readonly sessionMap = signal(new Map<string, SessionDto>());
  protected readonly sessions = computed(() =>
    [...this.sessionMap().values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    ),
  );

  ngOnInit(): void {
    this.socket.connect();
    this.socket.messages$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((message) => {
        if (message.type === 'session.updated') {
          this.upsert(message.session);
        }
      });
    this.api.list().subscribe({
      next: ({ sessions }) => {
        // Keep updates that arrived while the list was loading.
        const map = new Map(sessions.map((session) => [session.id, session]));
        for (const [id, session] of this.sessionMap()) {
          map.set(id, session);
        }
        this.sessionMap.set(map);
        this.loading.set(false);
      },
      error: () => {
        this.loadError.set('The sessions could not be loaded.');
        this.loading.set(false);
      },
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
}
