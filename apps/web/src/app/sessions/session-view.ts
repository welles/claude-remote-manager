import { TextFieldModule } from '@angular/cdk/text-field';
import { DecimalPipe, KeyValuePipe } from '@angular/common';
import { AppDatePipe } from '../ui/dates';
import {
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  canResume,
  PERMISSION_MODE_INFO,
  SESSION_PERMISSION_MODES,
  type ContextUsage,
  type LogPosition,
  type PermissionRequestEvent,
  type PermissionResponse,
  type ServerMessage,
  type SessionDto,
  type SessionPermissionMode,
  type PreviewDto,
  type ShownFileDto,
} from '@claude-remote-manager/shared-types';
import {
  applyDraft,
  applyEvent,
  buildConversation,
  pendingRequests,
  progressText,
  resolutionText,
  type ConversationItem,
} from './conversation';
import {
  formatCost,
  formatTokens,
  statusClass,
  statusLabel,
  totalTokens,
} from './format';
import { MarkdownPipe } from './markdown.pipe';
import { ModelsStore, modelOptionsWith, normalizeModel } from './models-store';
import { PermissionCard } from './permission-card';
import { ContextMeter } from './context-meter';
import { MessageImages } from '../attachments/message-images';
import { MessageContext } from '../github-references/message-context';
import { MessageText } from '../github-references/message-text';
import { sessionGitHubRepositories } from '../github-references/references';
import { ShownFileCard } from '../shown-files/shown-file-card';
import { PreviewCard } from '../previews/preview-card';
import { PreviewFrame } from '../previews/preview-frame';
import { currentPreview } from '../previews/previews-api';
import { SessionPreviews } from '../previews/session-previews';
import { FileViewer } from '../shown-files/file-viewer';
import { MessageComposer, type ComposedMessage } from './message-composer';
import { FileDiffCard } from '../diffs/file-diff-card';
import { QueuedMessages } from './queued-messages';
import { SessionDirectories, sessionPath } from './session-directories';
import { TodoPanel } from './todo-panel';
import { todoList } from './todos';
import { SessionGitPanel } from './session-git-panel';
import { SessionSocket } from './session-socket';
import { newId, SessionsApi } from './sessions-api';
import { CleanupDialog } from './cleanup-dialog';
import { SessionTitle } from './session-title';
import { DeleteSessionDialog } from './delete-session-dialog';
import { errorMessage } from '../repositories/repositories-api';

/** One session: the streamed conversation, input and usage. */
@Component({
  selector: 'app-session-view',
  imports: [
    CleanupDialog,
    ContextMeter,
    AppDatePipe,
    DecimalPipe,
    DeleteSessionDialog,
    SessionTitle,
    FileDiffCard,
    KeyValuePipe,
    MarkdownPipe,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MessageComposer,
    MessageContext,
    MessageImages,
    MessageText,
    PermissionCard,
    PreviewCard,
    PreviewFrame,
    QueuedMessages,
    FileViewer,
    ShownFileCard,
    RouterLink,
    SessionDirectories,
    SessionGitPanel,
    SessionPreviews,
    TextFieldModule,
    TodoPanel,
  ],
  templateUrl: './session-view.html',
  styleUrl: './session-view.scss',
})
export class SessionView implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly socket = inject(SessionSocket);
  private readonly destroyRef = inject(DestroyRef);
  private readonly modelsStore = inject(ModelsStore);
  private readonly host = inject(ElementRef);

  protected readonly statusLabel = statusLabel;
  protected readonly statusClass = statusClass;
  protected readonly resolutionText = resolutionText;
  protected readonly modes = SESSION_PERMISSION_MODES;
  protected readonly modeInfo = PERMISSION_MODE_INFO;
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
  /** A turn is in progress (possibly waiting for an approval). */
  protected readonly running = computed(() => {
    const session = this.session();
    return (
      session?.status === 'running' || session?.waitingFor === 'permission'
    );
  });
  /** Approval requests waiting for an answer, oldest first. */
  protected readonly requests = computed(() => pendingRequests(this.items()));
  /** IDs of requests whose answer is on its way. */
  protected readonly answering = signal(new Set<string>());
  /** Messages waiting for the current turn to end. */
  protected readonly queued = computed(() =>
    this.items().filter(
      (item): item is Extract<ConversationItem, { kind: 'queued' }> =>
        item.kind === 'queued' && item.state === 'queued',
    ),
  );
  /** Claude's task list. */
  protected readonly todos = computed(() => todoList(this.items()));
  /** Models to choose from, including the session's own. */
  protected readonly normalizeModel = normalizeModel;
  protected readonly modelOptions = computed(() =>
    modelOptionsWith(this.modelsStore.models(), this.session()?.model ?? null),
  );
  /** Model the session's choice currently resolves to, when known. */
  protected readonly resolvedModel = computed(() => {
    const model = normalizeModel(this.session()?.model ?? null);
    return (
      this.modelOptions().find((option) => option.value === model)
        ?.resolvedModel ??
      this.context()?.model ??
      null
    );
  });
  /** GitHub repositories of the session for `#` references. */
  protected readonly githubRepositories = computed(() =>
    sessionGitHubRepositories(this.session()),
  );
  /** The session has clones, so the changes page has something to show. */
  protected readonly hasRepositories = computed(
    () =>
      this.session()?.directories.some(
        (directory) =>
          directory.kind === 'clone' && directory.state === 'ready',
      ) ?? false,
  );
  protected readonly preparing = computed(
    () => this.session()?.status === 'preparing',
  );
  /** The first message waits for a decision after a failed setup script. */
  protected readonly heldBack = computed(() => {
    const session = this.session();
    return session?.status === 'waiting' && session.pendingMessage !== null;
  });
  /**
   * Text in the input box. A signal bound to the textarea's value (not
   * ngModel, whose asynchronous write could leave sent text in the box).
   */
  protected readonly draft = signal('');
  private readonly composer = viewChild(MessageComposer);
  protected readonly composerLabel = computed(() =>
    this.preparing()
      ? 'Available when the preparation is done'
      : !this.resumable()
        ? this.removedDirectories()
          ? 'The session cannot be continued: its directories were removed'
          : 'Unarchive the session to continue it'
        : this.running()
          ? 'Queue a message'
          : 'Message',
  );
  /** The session can take messages (not archived, all directories there). */
  protected readonly resumable = computed(() => {
    const session = this.session();
    return !session || canResume(session);
  });
  /** Names of the session's directories that were removed, if any. */
  protected readonly removedDirectories = computed(() => {
    const removed =
      this.session()?.directories.filter(
        (directory) => directory.state === 'removed',
      ) ?? [];
    if (removed.length === 0) {
      return null;
    }
    const names = removed.map((directory) =>
      directory.kind === 'scratch'
        ? 'the scratch directory'
        : `the clone of ${directory.repository?.fullName ?? directory.path}`,
    );
    const text = names.join(', ');
    return {
      text: text.charAt(0).toUpperCase() + text.slice(1),
      verb: names.length === 1 ? 'was' : 'were',
    };
  });
  private readonly ended = computed(() => {
    const status = this.session()?.status;
    return status === 'finished' || status === 'failed';
  });
  /** Ended, with clones or a scratch directory left. */
  protected readonly canCleanUp = computed(
    () =>
      this.ended() &&
      (this.session()?.directories.some(
        (directory) =>
          directory.state === 'ready' && directory.kind !== 'directory',
      ) ??
        false),
  );
  protected readonly canArchive = computed(() => {
    const session = this.session();
    return (
      !!session &&
      !session.archivedAt &&
      session.status !== 'preparing' &&
      !this.running()
    );
  });
  protected readonly canDelete = computed(
    () => !!this.session()?.archivedAt || this.ended(),
  );
  private readonly sessionsApi = inject(SessionsApi);
  private readonly router = inject(Router);

  /** Request IDs of frames this view sent, to show their errors. */
  private readonly pending = new Set<string>();
  /** Frame request ID → approval request ID, for answers on their way. */
  private readonly answers = new Map<string, string>();
  /** How far this view has seen the session's log, for reconnects. */
  private position: LogPosition | null = null;
  /** Whether the page is scrolled to the end; then new content stays in view. */
  private stickToBottom = true;

  constructor() {
    let revealed = false;
    afterRenderEffect(() => {
      this.items();
      if (this.loaded() && !revealed) {
        revealed = true;
        this.revealSearchTarget();
      }
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
    this.modelsStore.load();
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

  protected send(message: ComposedMessage): void {
    const requestId = newId();
    const sent = this.socket.send({
      type: 'message.send',
      sessionId: this.sessionId(),
      id: message.id ?? newId(),
      text: message.text,
      ...(message.attachmentIds.length > 0
        ? { attachmentIds: message.attachmentIds }
        : {}),
      ...(message.references.length > 0
        ? { references: message.references }
        : {}),
      requestId,
    });
    if (!sent) {
      this.error.set('Not connected to the server. Try again in a moment.');
      return;
    }
    this.pending.add(requestId);
    this.error.set(null);
    this.composer()?.clear();
    this.stickToBottom = true;
  }

  /** Answers an approval request. */
  protected respond(
    request: PermissionRequestEvent,
    response: PermissionResponse,
  ): void {
    const requestId = newId();
    if (
      this.socket.send({
        type: 'permission.respond',
        sessionId: this.sessionId(),
        permissionRequestId: request.requestId,
        requestId,
        ...response,
      })
    ) {
      this.pending.add(requestId);
      this.answers.set(requestId, request.requestId);
      this.answering.update((ids) => new Set(ids).add(request.requestId));
      this.error.set(null);
    } else {
      this.error.set('Not connected to the server. Try again in a moment.');
    }
  }

  /** Removes a queued message before it goes to Claude. */
  protected unqueue(messageId: string): void {
    const requestId = newId();
    if (
      this.socket.send({
        type: 'message.unqueue',
        sessionId: this.sessionId(),
        messageId,
        requestId,
      })
    ) {
      this.pending.add(requestId);
    }
  }

  /** Puts a message that was not sent back into the input. */
  protected edit(item: Extract<ConversationItem, { kind: 'queued' }>): void {
    this.composer()?.restore(
      item.id,
      item.text,
      item.attachments,
      item.references,
    );
  }

  /** Switches the model (`''`: default) or the permission mode. */
  protected configure(change: {
    model?: string;
    permissionMode?: SessionPermissionMode;
  }): void {
    const requestId = newId();
    const sent = this.socket.send({
      type: 'session.update',
      sessionId: this.sessionId(),
      ...(change.model !== undefined ? { model: change.model || null } : {}),
      ...(change.permissionMode
        ? { permissionMode: change.permissionMode }
        : {}),
      requestId,
    });
    if (sent) {
      this.pending.add(requestId);
      this.error.set(null);
    }
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

  /** Sends the first message although a setup script failed. */
  protected sendPending(): void {
    this.sendAction('pending.send');
  }

  /** Runs the failed setup scripts again. */
  protected rerunSetup(): void {
    this.sendAction('setup.rerun');
  }

  private sendAction(type: 'pending.send' | 'setup.rerun'): void {
    const requestId = newId();
    if (this.socket.send({ type, sessionId: this.sessionId(), requestId })) {
      this.pending.add(requestId);
      this.error.set(null);
    }
  }

  protected unarchive(): void {
    this.sessionsApi.unarchive(this.sessionId()).subscribe({
      next: (session) => this.session.set(session),
      error: (error: unknown) =>
        this.error.set(errorMessage(error, 'The session was not unarchived.')),
    });
  }

  /** The session was deleted: back to the list. */
  protected deleted(): void {
    void this.router.navigate(['/']);
  }

  /** The anchor of an assistant text item (Claude's message ID). */
  protected anchorOf(key: string): string | null {
    return key.startsWith('text:') ? (key.split(':')[1] ?? null) : null;
  }

  /**
   * Shows the place a search result points to (`?at=` message ID, else the
   * first message containing the first word of `?q=`), once the history
   * has loaded.
   */
  private revealSearchTarget(): void {
    const params = this.route.snapshot.queryParamMap;
    const anchor = params.get('at');
    const word = (params.get('q') ?? '').trim().split(/\s+/)[0]?.toLowerCase();
    if (!anchor && !word) {
      return;
    }
    const host: HTMLElement = this.host.nativeElement;
    let target = anchor
      ? host.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(anchor)}"]`)
      : null;
    if (!target && word) {
      target =
        [
          ...host.querySelectorAll<HTMLElement>(
            '.user-message, .assistant-text',
          ),
        ].find((element) =>
          (element.textContent ?? '').toLowerCase().includes(word),
        ) ?? null;
    }
    if (target) {
      this.stickToBottom = false;
      target.scrollIntoView({ block: 'center' });
      target.classList.add('search-target');
      setTimeout(() => target?.classList.remove('search-target'), 4000);
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

  protected toolState(
    item: Extract<ConversationItem, { kind: 'tool' }>,
  ): string {
    if (item.byApp) {
      return item.byApp.outcome === 'succeeded' ? 'done by the app' : 'failed';
    }
    if (item.denied) {
      return 'denied';
    }
    const permission = item.permission;
    if (permission && !permission.resolved) {
      return permission.request.kind === 'question'
        ? 'question'
        : 'needs approval';
    }
    if (permission?.resolved?.decision === 'deny') {
      return permission.resolved.cause === 'user' ? 'denied' : 'cancelled';
    }
    if (!item.result) {
      return this.running() ? 'running' : 'no result';
    }
    return item.result.isError ? 'error' : 'done';
  }

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

  /** The file open in the viewer. */
  protected readonly viewing = signal<ShownFileDto | null>(null);
  /** The preview shown in a frame; its state follows the session. */
  private readonly embeddedPreview = signal<PreviewDto | null>(null);
  protected readonly embedded = computed(() => {
    const preview = this.embeddedPreview();
    return preview ? this.current(preview) : null;
  });

  /** A preview (e.g. from the history) as it is now. */
  protected current(preview: PreviewDto): PreviewDto {
    return currentPreview(preview, this.session()?.previews ?? []);
  }

  protected embedPreview(preview: PreviewDto): void {
    this.embeddedPreview.set(preview);
  }

  protected closePreview(): void {
    this.embeddedPreview.set(null);
  }

  /** Opens a file Claude showed in the viewer. */
  protected openFile(file: ShownFileDto): void {
    this.viewing.set(file);
  }

  /** A path of the session, relative to its directories. */
  protected sessionPath(path: string): string {
    return sessionPath(path, this.session()?.directories ?? []);
  }

  protected inputJson(input: unknown): string {
    return JSON.stringify(input, null, 2);
  }

  /** An answer frame was acknowledged or refused: the card is usable again. */
  private answered(frameRequestId: string): void {
    const requestId = this.answers.get(frameRequestId);
    if (requestId) {
      this.answers.delete(frameRequestId);
      this.answering.update((ids) => {
        const next = new Set(ids);
        next.delete(requestId);
        return next;
      });
    }
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
              session
                ? {
                    ...session,
                    status: event.status,
                    waitingFor: event.waitingFor ?? null,
                  }
                : session,
            );
          }
        }
        return;
      case 'session.updated':
        if (message.session.id === id) {
          this.session.set(message.session);
        }
        return;
      case 'session.deleted':
        if (message.sessionId === id) {
          void this.router.navigate(['/']);
        }
        return;
      case 'error':
        if (message.requestId) {
          this.answered(message.requestId);
        }
        if (message.requestId && this.pending.has(message.requestId)) {
          this.pending.delete(message.requestId);
          this.error.set(message.message);
        } else if (message.requestId === null) {
          this.error.set(message.message);
        }
        return;
      case 'ack':
        this.pending.delete(message.requestId);
        this.answered(message.requestId);
        return;
      default:
        return;
    }
  }
}

export { directoryName } from './session-directories';
