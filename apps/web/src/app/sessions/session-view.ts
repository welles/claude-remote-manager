import { AppDatePipe, formatClock } from '../ui/dates';
import { AppBanner } from '../ui/banner';
import { AppIcon } from '../ui/icon';
import { AppPageBar } from '../ui/page-bar';
import { StatusBadge } from '../ui/status-badge';
import { AppSidePanel } from '../ui/side-panel';
import { mediaQuery, WIDE_LIST, WIDE_PANEL } from '../ui/media';
import { PaneResizer, PaneWidth } from '../ui/pane-resizer';
import { LimitWindows } from '../limits/limit-windows';
import { SessionList } from './session-list';
import { SessionStrip, type DetailSection } from './session-strip';
import { SessionConversation, type QueuedItem } from './session-conversation';
import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  effect,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  canResume,
  isRetiredClone,
  PERMISSION_MODE_INFO,
  PERMISSION_MODE_OVERRIDE_INFO,
  DANGEROUS_PERMISSION_MODES,
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
  type ConversationItem,
} from './conversation';
import { groupPreparation } from './preparation';
import { formatCost, formatTokens, needLabel, totalTokens } from './format';
import {
  ModelsStore,
  modelLabel,
  modelOptionsWith,
  normalizeModel,
} from './models-store';
import { PermissionCard } from './permission-card';
import { ContextMeter } from './context-meter';
import { sessionGitHubRepositories } from '../github-references/references';
import { PreviewFrame } from '../previews/preview-frame';
import { currentPreview } from '../previews/previews-api';
import { SessionPreviews } from '../previews/session-previews';
import { FileViewer } from '../shown-files/file-viewer';
import { MessageComposer, type ComposedMessage } from './message-composer';
import { applySuggestion } from './prompt-suggestion';
import { QueuedMessages } from './queued-messages';
import { SessionDirectories } from './session-directories';
import { AddRepository } from './add-repository';
import { AdditionBanners } from './addition-banners';
import { TodoPanel } from './todo-panel';
import { todoList } from './todos';
import { SessionGitPanel } from './session-git-panel';
import { SessionSocket } from './session-socket';
import { newId, SessionsApi } from './sessions-api';
import { SessionDrafts } from './session-drafts';
import { CleanupDialog } from './cleanup-dialog';
import { SessionTitle } from './session-title';
import { DeleteSessionDialog } from './delete-session-dialog';
import { errorMessage } from '../repositories/repositories-api';
import { Toasts } from '../ui/toasts';

/** One session: the streamed conversation, input and usage. */
/** One `@path` reference, as the file browser hands it over (`?mention=`). */
const MENTION_TOKEN = /^@(?:"[^"\n]{1,4096}"|[^\s"]{1,4096})$/;

@Component({
  selector: 'app-session-view',
  imports: [
    AddRepository,
    AdditionBanners,
    AppSidePanel,
    PaneResizer,
    SessionConversation,
    LimitWindows,
    SessionList,
    SessionStrip,
    CleanupDialog,
    ContextMeter,
    AppBanner,
    AppIcon,
    AppPageBar,
    AppDatePipe,
    StatusBadge,
    DeleteSessionDialog,
    SessionTitle,
    MatButtonModule,
    MatFormFieldModule,
    MatProgressBarModule,
    MatSelectModule,
    MessageComposer,
    PermissionCard,
    PreviewFrame,
    QueuedMessages,
    FileViewer,
    RouterLink,
    SessionDirectories,
    SessionGitPanel,
    SessionPreviews,
    TodoPanel,
  ],
  templateUrl: './session-view.html',
  styleUrl: './session-view.scss',
})
export class SessionView implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly socket = inject(SessionSocket);
  private readonly toasts = inject(Toasts);
  private readonly destroyRef = inject(DestroyRef);
  private readonly modelsStore = inject(ModelsStore);
  private readonly host = inject(ElementRef);

  protected readonly modes = SESSION_PERMISSION_MODES;
  protected readonly dangerousModes = DANGEROUS_PERMISSION_MODES;
  protected readonly modeInfo = PERMISSION_MODE_INFO;
  protected readonly overrideInfo = PERMISSION_MODE_OVERRIDE_INFO;
  protected readonly formatCost = formatCost;
  protected readonly formatTokens = formatTokens;
  protected readonly totalTokens = totalTokens;
  protected readonly connected = this.socket.connected;
  protected readonly incompatible = this.socket.incompatible;

  protected readonly needLabel = needLabel;
  /** The session list beside the session (wide screens). */
  protected readonly wideList = mediaQuery(WIDE_LIST);
  /** The details as a permanent column (wider screens). */
  protected readonly docked = mediaQuery(WIDE_PANEL);
  /** Widths the user gave the session list and the docked details. */
  protected readonly listWidth = new PaneWidth('crm.paneWidth.list', {
    min: 240,
    max: 560,
    initial: 320,
    windowShare: 0.3,
  });
  protected readonly detailsWidth = new PaneWidth('crm.paneWidth.details', {
    min: 280,
    max: 640,
    initial: 340,
    windowShare: 0.34,
  });
  /** The details are open (phone and narrower desktops). */
  protected readonly panelOpen = signal(false);
  private readonly panel = viewChild(AppSidePanel);
  protected readonly cleanupDialog = viewChild(CleanupDialog);
  protected readonly deleteDialog = viewChild(DeleteSessionDialog);

  protected readonly sessionId = signal('');
  protected readonly session = signal<SessionDto | null>(null);
  protected readonly items = signal<ConversationItem[]>([]);
  protected readonly context = signal<ContextUsage | null>(null);
  /** Claude Code's guess at the next message (until one is sent). */
  protected readonly suggestion = signal<string | null>(null);
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
  /**
   * IDs of queued messages the user sent right away; until the stopped
   * turn ends they show as being sent (cleared again if refused).
   */
  protected readonly sendingNow = signal<ReadonlySet<string>>(new Set());
  /** Messages waiting for the current turn to end. */
  protected readonly queued = computed(() =>
    this.items().filter(
      (item): item is Extract<ConversationItem, { kind: 'queued' }> =>
        item.kind === 'queued' && item.state === 'queued',
    ),
  );
  /**
   * What the conversation shows: consecutive preparation steps become one
   * collapsible row ("Prepare: …"), open while a step failed.
   */
  protected readonly shownItems = computed(() =>
    groupPreparation(this.items()),
  );
  /** Name of the session's model for the strip. */
  protected readonly modelName = computed(() =>
    modelLabel(this.modelOptions(), this.session()?.model ?? null).replace(
      /\s*\((?!1M\)).*\)$/,
      '',
    ),
  );
  /**
   * The permission mode in effect, for the strip: the chosen one, or the
   * one the process runs in instead (e.g. "Ask (auto unavailable)").
   */
  protected readonly modeName = computed(() => {
    const session = this.session();
    if (!session) {
      return '';
    }
    const override = session.permissionModeOverride;
    return override
      ? `${this.modeInfo[override.mode].label} (${this.overrideInfo[override.reason].label})`
      : this.modeInfo[session.permissionMode].label;
  });
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
  /**
   * When the session continues after the usage limit stopped it, while it
   * waits for that (`waitingFor: 'limit'`); `resumes` is `null` when not
   * known.
   */
  protected readonly limitWait = computed(() => {
    const session = this.session();
    if (session?.status !== 'waiting' || session.waitingFor !== 'limit') {
      return null;
    }
    const at = session.limitResumesAt
      ? formatClock(session.limitResumesAt, Date.now())
      : null;
    return {
      resumes: at
        ? session.limitResetKnown
          ? `around ${at}`
          : `the app looks again at ${at}`
        : null,
    };
  });
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
        : this.running() || this.limitWait() !== null
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
        (directory) =>
          directory.state === 'removed' && !isRetiredClone(directory),
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
  /**
   * The user continues an ended session (Continue, text in the input, a
   * withdrawn message taken back): the input shows. Reset when the session
   * changes or ends again.
   */
  protected readonly continuing = signal(false);
  /**
   * An ended session that is not archived offers archiving instead of the
   * input, with Continue when it can be continued.
   */
  protected readonly offerArchive = computed(
    () =>
      this.session()?.status === 'finished' &&
      this.canArchive() &&
      !this.continuing() &&
      this.requests().length === 0 &&
      this.queued().length === 0,
  );
  protected readonly canDelete = computed(
    () => !!this.session()?.archivedAt || this.ended(),
  );
  private readonly injector = inject(Injector);
  private readonly sessionsApi = inject(SessionsApi);
  private readonly router = inject(Router);
  private readonly drafts = inject(SessionDrafts);

  /** Request IDs of frames this view sent, to show their errors. */
  private readonly pending = new Set<string>();
  /** Frame request ID → approval request ID, for answers on their way. */
  private readonly answers = new Map<string, string>();
  /** Frame request ID → IDs of queued messages sent right away. */
  private readonly sendRequests = new Map<string, string[]>();
  /** How far this view has seen the session's log, for reconnects. */
  private position: LogPosition | null = null;
  /** Whether the page is scrolled to the end; then new content stays in view. */
  private stickToBottom = true;

  constructor() {
    // Unsent text stays with its session.
    effect(() => {
      const id = this.sessionId();
      const text = this.draft();
      if (id) {
        this.drafts.set(id, text);
      }
    });
    // Text in the input (a draft, a reference from the file browser) means
    // the user continues: the input stays, also when it is emptied.
    effect(() => {
      if (this.draft().trim()) {
        untracked(() => this.continuing.set(true));
      }
    });
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
        this.draft.set(this.drafts.get(id));
        this.continuing.set(false);
        this.takeMention();
        this.session.set(null);
        this.items.set([]);
        this.context.set(null);
        this.suggestion.set(null);
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
    // The message answers the suggestion, whether taken or not.
    this.suggestion.set(null);
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

  /**
   * Stops the turn and sends a queued message (`null`: all of them) right
   * away.
   */
  protected sendQueuedNow(messageId: string | null): void {
    const requestId = newId();
    if (
      this.socket.send({
        type: 'queue.send',
        sessionId: this.sessionId(),
        ...(messageId ? { messageId } : {}),
        requestId,
      })
    ) {
      this.pending.add(requestId);
      const ids = messageId
        ? [messageId]
        : this.queued().map((item) => item.id);
      this.sendRequests.set(requestId, ids);
      this.sendingNow.update((sending) => new Set([...sending, ...ids]));
    } else {
      this.error.set('Not connected to the server. Try again in a moment.');
    }
  }

  /** Sending right away was refused: the messages wait again. */
  private sendRefused(frameRequestId: string): void {
    const ids = this.sendRequests.get(frameRequestId);
    if (ids) {
      this.sendingNow.update((sending) => {
        const next = new Set(sending);
        for (const id of ids) {
          next.delete(id);
        }
        return next;
      });
    }
  }

  /** Puts a message that was not sent back into the input. */
  protected edit(item: QueuedItem): void {
    this.continuing.set(true);
    // The input may only now be rendered.
    afterNextRender(
      () =>
        this.composer()?.restore(
          item.id,
          item.text,
          item.attachments,
          item.references,
        ),
      { injector: this.injector },
    );
  }

  /** A session that ends again offers archiving again. */
  private endedAgain(status: SessionDto['status']): void {
    const before = this.session()?.status;
    // Not while something waits in the input: it would vanish mid-typing.
    if (
      status === 'finished' &&
      before &&
      before !== 'finished' &&
      !this.composer()?.hasContent()
    ) {
      this.continuing.set(false);
    }
  }

  /** Shows the input of an ended session instead of the archive offer. */
  protected continueSession(): void {
    this.continuing.set(true);
    afterNextRender(() => this.composer()?.focus(), {
      injector: this.injector,
    });
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

  /** Continues the session now instead of when the usage limit resets. */
  protected resumeAfterLimit(): void {
    this.sendAction('limit.resume');
  }

  /** Does not continue the session by itself after the usage limit. */
  protected cancelLimitWait(): void {
    this.sendAction('limit.cancel');
  }

  private sendAction(
    type: 'pending.send' | 'setup.rerun' | 'limit.resume' | 'limit.cancel',
  ): void {
    const requestId = newId();
    if (this.socket.send({ type, sessionId: this.sessionId(), requestId })) {
      this.pending.add(requestId);
      this.error.set(null);
    }
  }

  protected unarchive(): void {
    this.sessionsApi.unarchive(this.sessionId()).subscribe({
      next: (session) => {
        // Unarchived to continue it: the input shows, not the archive offer.
        this.continuing.set(true);
        this.session.set(session);
        this.toasts.show({ title: 'Session unarchived' });
      },
      error: (error: unknown) =>
        this.error.set(errorMessage(error, 'The session was not unarchived.')),
    });
  }

  /** The session was deleted or archived: back to the list. */
  protected toList(): void {
    void this.router.navigate(['/']);
  }

  /**
   * A file referenced from the file browser (`?mention=@path`): added to
   * the input, then dropped from the URL.
   */
  private takeMention(): void {
    const mention = this.route.snapshot.queryParamMap.get('mention');
    if (mention === null) {
      return;
    }
    if (!MENTION_TOKEN.test(mention)) {
      // Only ever one `@path`: a link must not fill the input with text.
      this.dropMentionParam();
      return;
    }
    this.draft.update((text) =>
      text.trim() ? `${text.replace(/\s+$/, '')} ${mention} ` : `${mention} `,
    );
    this.dropMentionParam();
  }

  private dropMentionParam(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { mention: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
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
            // Not a subagent's text in a closed group of tool calls.
            '.user-message, .assistant-text:not(.group-body > *)',
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

  /** Opens the details at a section, or goes to the pending request. */
  protected openPanel(section: DetailSection | 'dock'): void {
    if (section === 'dock') {
      this.stickToBottom = true;
      window.scrollTo({ top: document.documentElement.scrollHeight });
      return;
    }
    this.panelOpen.set(true);
    this.panel()?.reveal(`details-${section}`);
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
          this.endedAgain(message.session.status);
          this.session.set(message.session);
          let items = message.complete
            ? buildConversation(message.events)
            : message.events.reduce(applyEvent, this.items());
          items = message.drafts.reduce(applyDraft, items);
          this.items.set(items);
          this.suggestion.set(
            message.events.reduce(
              applySuggestion,
              message.complete ? null : this.suggestion(),
            ),
          );
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
          this.suggestion.update((text) => applySuggestion(text, event));
          if (event.type === 'context.usage') {
            this.context.set(event.context);
          } else if (event.type === 'session.status') {
            this.endedAgain(event.status);
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
          this.endedAgain(message.session.status);
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
          this.sendRefused(message.requestId);
          this.sendRequests.delete(message.requestId);
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
        this.sendRequests.delete(message.requestId);
        return;
      default:
        return;
    }
  }
}

export { directoryName } from './session-directories';
