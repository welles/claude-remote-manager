import { TextFieldModule } from '@angular/cdk/text-field';
import { DecimalPipe } from '@angular/common';
import {
  Component,
  DestroyRef,
  afterRenderEffect,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type {
  ContextUsage,
  LogPosition,
  ServerMessage,
  SessionDirectoryDto,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import {
  applyDraft,
  applyEvent,
  buildConversation,
  progressText,
  type ConversationItem,
} from './conversation';
import { formatCost, formatTokens, STATUS_LABELS, totalTokens } from './format';
import { MarkdownPipe } from './markdown.pipe';
import { SessionSocket } from './session-socket';
import { newId } from './sessions-api';

/** One session: the streamed conversation, input and usage. */
@Component({
  selector: 'app-session-view',
  imports: [
    DecimalPipe,
    MarkdownPipe,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    RouterLink,
    TextFieldModule,
  ],
  templateUrl: './session-view.html',
  styleUrl: './session-view.scss',
})
export class SessionView implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly socket = inject(SessionSocket);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly statusLabels = STATUS_LABELS;
  protected readonly formatCost = formatCost;
  protected readonly formatTokens = formatTokens;
  protected readonly totalTokens = totalTokens;
  protected readonly progressText = progressText;
  protected readonly connected = this.socket.connected;
  protected readonly incompatible = this.socket.incompatible;

  protected readonly sessionId = signal('');
  protected readonly session = signal<SessionDto | null>(null);
  protected readonly items = signal<ConversationItem[]>([]);
  protected readonly context = signal<ContextUsage | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loaded = signal(false);
  protected readonly running = computed(
    () => this.session()?.status === 'running',
  );
  protected readonly preparing = computed(
    () => this.session()?.status === 'preparing',
  );
  /** Repository names (or project) for the collapsed directory list. */
  protected readonly workspaceSummary = computed(() =>
    (this.session()?.directories ?? [])
      .map((directory) => directoryName(directory))
      .join(' + '),
  );
  /**
   * Text in the input box. A signal bound to the textarea's value (not
   * ngModel, whose asynchronous write could leave sent text in the box).
   */
  protected readonly draft = signal('');

  /** Request IDs of frames this view sent, to show their errors. */
  private readonly pending = new Set<string>();
  /** How far this view has seen the session's log, for reconnects. */
  private position: LogPosition | null = null;
  /** Whether the page is scrolled to the end; then new content stays in view. */
  private stickToBottom = true;

  constructor() {
    afterRenderEffect(() => {
      this.items();
      if (this.stickToBottom) {
        window.scrollTo({ top: document.documentElement.scrollHeight });
      }
    });
    const onScroll = () => {
      const { scrollHeight } = document.documentElement;
      this.stickToBottom =
        window.innerHeight + window.scrollY >= scrollHeight - 80;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    this.destroyRef.onDestroy(() =>
      window.removeEventListener('scroll', onScroll),
    );
  }

  ngOnInit(): void {
    this.socket.messages$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((message) => this.handle(message));
    this.route.paramMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const previous = this.sessionId();
        if (previous) {
          this.socket.unsubscribe(previous);
        }
        const id = params.get('id') ?? '';
        this.sessionId.set(id);
        this.session.set(null);
        this.items.set([]);
        this.context.set(null);
        this.loaded.set(false);
        this.position = null;
        this.socket.subscribe(id, () => this.position);
      });
    this.destroyRef.onDestroy(() => this.socket.unsubscribe(this.sessionId()));
  }

  protected send(): void {
    const text = this.draft().trim();
    if (!text) {
      return;
    }
    const requestId = newId();
    const sent = this.socket.send({
      type: 'message.send',
      sessionId: this.sessionId(),
      id: newId(),
      text,
      requestId,
    });
    if (!sent) {
      this.error.set('Not connected to the server. Try again in a moment.');
      return;
    }
    this.pending.add(requestId);
    this.error.set(null);
    this.draft.set('');
    this.stickToBottom = true;
  }

  protected interrupt(): void {
    const requestId = newId();
    if (
      this.socket.send({
        type: 'interrupt',
        sessionId: this.sessionId(),
        requestId,
      })
    ) {
      this.pending.add(requestId);
    }
  }

  /** Stops the session's process and marks it finished. */
  protected end(): void {
    const requestId = newId();
    if (
      this.socket.send({
        type: 'session.end',
        sessionId: this.sessionId(),
        requestId,
      })
    ) {
      this.pending.add(requestId);
    }
  }

  protected onInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.send();
    }
  }

  protected toolState(
    item: Extract<ConversationItem, { kind: 'tool' }>,
  ): string {
    if (item.denied) {
      return 'denied';
    }
    if (!item.result) {
      return this.running() ? 'running' : 'no result';
    }
    return item.result.isError ? 'error' : 'done';
  }

  protected readonly directoryName = directoryName;

  protected setupState(
    item: Extract<ConversationItem, { kind: 'setup' }>,
  ): string {
    switch (item.state) {
      case 'started':
        return 'running';
      case 'failed':
        return item.exitCode !== null
          ? `failed (exit ${item.exitCode})`
          : 'failed';
      case 'timed_out':
        return 'timed out';
      default:
        return item.state;
    }
  }

  protected inputJson(input: unknown): string {
    return JSON.stringify(input, null, 2);
  }

  private handle(message: ServerMessage): void {
    const id = this.sessionId();
    switch (message.type) {
      case 'session.history':
        if (message.session.id === id) {
          this.session.set(message.session);
          let items = message.complete
            ? buildConversation(message.events)
            : message.events.reduce(applyEvent, this.items());
          items = message.drafts.reduce(applyDraft, items);
          this.items.set(items);
          this.position = {
            logId: message.logId,
            seq: Math.max(
              message.complete ? 0 : (this.position?.seq ?? 0),
              message.events.at(-1)?.seq ?? 0,
            ),
          };
          const lastContext = message.events.findLast(
            (event) => event.type === 'context.usage',
          );
          this.context.set(
            message.session.context ??
              (lastContext?.type === 'context.usage'
                ? lastContext.context
                : message.complete
                  ? null
                  : this.context()),
          );
          this.loaded.set(true);
        }
        return;
      case 'session.event':
        if (message.sessionId === id) {
          const event = message.event;
          if (this.position) {
            this.position = { ...this.position, seq: event.seq };
          }
          this.items.update((items) => applyEvent(items, event));
          if (event.type === 'context.usage') {
            this.context.set(event.context);
          } else if (event.type === 'session.status') {
            this.session.update((session) =>
              session ? { ...session, status: event.status } : session,
            );
          }
        }
        return;
      case 'session.updated':
        if (message.session.id === id) {
          this.session.set(message.session);
        }
        return;
      case 'error':
        if (message.requestId && this.pending.has(message.requestId)) {
          this.pending.delete(message.requestId);
          this.error.set(message.message);
        } else if (message.requestId === null) {
          this.error.set(message.message);
        }
        return;
      case 'ack':
        this.pending.delete(message.requestId);
        return;
      default:
        return;
    }
  }
}

/** Name of a session directory: repository, project or the directory itself. */
export function directoryName(directory: SessionDirectoryDto): string {
  return (
    directory.repository?.fullName ??
    directory.projectName ??
    directory.path.split('/').filter(Boolean).at(-1) ??
    directory.path
  );
}
