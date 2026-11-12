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
import { TextFieldModule } from '@angular/cdk/text-field';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { Router, RouterLink } from '@angular/router';
import type { SessionDto } from '@claude-remote-manager/shared-types';
import { formatCost, formatTokens, STATUS_LABELS, totalTokens } from './format';
import { SessionSocket } from './session-socket';
import { SessionsApi } from './sessions-api';

/** Models offered for new sessions; the empty value uses Claude Code's default. */
export const MODEL_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

/** Start page: all sessions with their status, and a form for a new one. */
@Component({
  selector: 'app-session-list',
  imports: [
    DatePipe,
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    RouterLink,
    TextFieldModule,
  ],
  templateUrl: './session-list.html',
  styleUrl: './session-list.scss',
})
export class SessionList implements OnInit {
  private readonly api = inject(SessionsApi);
  private readonly socket = inject(SessionSocket);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly statusLabels = STATUS_LABELS;
  protected readonly modelOptions = MODEL_OPTIONS;
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

  protected prompt = '';
  protected model = '';
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);

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

  protected create(): void {
    const prompt = this.prompt.trim();
    if (!prompt || this.creating()) {
      return;
    }
    this.creating.set(true);
    this.createError.set(null);
    this.api
      .create({ prompt, ...(this.model ? { model: this.model } : {}) })
      .subscribe({
        next: (session) => {
          this.creating.set(false);
          this.prompt = '';
          void this.router.navigate(['/sessions', session.id]);
        },
        error: (error: { error?: { message?: string } }) => {
          this.creating.set(false);
          this.createError.set(
            error.error?.message ?? 'The session could not be started.',
          );
        },
      });
  }

  protected onPromptKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.create();
    }
  }

  private upsert(session: SessionDto): void {
    this.sessionMap.update((map) => new Map(map).set(session.id, session));
  }
}
