import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Subject } from 'rxjs';
import type {
  CanUseTool,
  PermissionMode,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  SESSION_PERMISSION_MODES,
  type AttachmentDto,
  type ContextUsage,
  type CreateSessionRequest,
  type FileDiff,
  type LogPosition,
  type PermissionRequestEvent,
  type PermissionResponseResult,
  type PullRequestCall,
  type SessionDto,
  type SessionEvent,
  type SessionDirectoryDto,
  type SessionEventInput,
  type SessionPermissionMode,
  type SessionStatus,
  type SessionWaitingFor,
  type UpdateSessionRequest,
} from '@claude-remote-manager/shared-types';
import {
  AgentRunner,
  type AgentRun,
  type AgentUserMessage,
} from '../agent/agent-runner';
import { AttachmentStore } from '../attachments/attachment.store';
import {
  ToolApprover,
  type PermissionResolvedInput,
} from '../agent/tool-approval';
import {
  APP_MCP_SERVER,
  CREATE_PULL_REQUEST_TOOL_NAME,
  SHOW_FILE_TOOL_NAME,
} from './approval-grants';
import { sessionAllows, unresolvedRequests } from './permission-requests';
import { UserToolApprover } from './user-tool-approver';
import {
  optionalEnum,
  optionalString,
  optionalUuid,
  optionalUuidArray,
  requireObject,
} from '../common/validation';
import { TranscriptReader } from '../agent/transcript-reader';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { LimitsService } from '../limits/limits.service';
import {
  SessionWorkspaceService,
  type SetupOutcome,
} from '../workspaces/session-workspace.service';
import { pullRequestDto } from './pull-request-dto';
import {
  NoSessionAgentSupport,
  SessionAgentSupport,
} from './session-agent-support';
import {
  SdkEventMapper,
  transcriptEntries,
  type SeenImage,
} from './sdk-event-mapper';
import {
  SessionEventRepository,
  STORED_EVENT_TYPES,
  type EventAnchor,
} from './session-event.repository';
import { buildHistory, SessionLog, type LogSnapshot } from './session-log';
import { changedFile, proposedDiff, withInputDiffs } from '../diffs/tool-diffs';
import {
  FileAccessError,
  SessionFileAccess,
} from '../files/session-file-access';
import { ShownFilesService } from '../shown-files/shown-files.service';
import {
  additionalDirectories,
  SessionRepository,
  workingDirectory,
  type SessionRecord,
} from './session.repository';
import { EMPTY_USAGE, UsageRepository } from './usage.repository';
import { sumUsage, UsageTracker } from './usage-tracker';

const MAX_MESSAGE_LENGTH = 100_000;
const MAX_TITLE_LENGTH = 200;
const MODEL_PATTERN = /^[\w.[\]-]{1,100}$/;
/**
 * Environment every Claude Code process of a session gets. The task list
 * tools (`TaskCreate`, `TaskUpdate`, …) are off in SDK sessions of the
 * bundled Claude Code unless enabled; the session view shows that list.
 */
export const SESSION_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
};

/** Files larger than this are diffed from the tool input for approvals. */
export const PROPOSED_DIFF_MAX_BYTES = 1024 * 1024;

/** Context usage is re-read at most this often while a turn runs. */
export const CONTEXT_REFRESH_INTERVAL_MS = 5000;

/** A user message on its way to Claude. */
interface UserMessage {
  id: string;
  text: string;
  /** Images of the message (`[]` without). */
  attachments: AttachmentDto[];
}

/** A queued message, ready for Claude Code (images loaded). */
interface QueuedMessage extends UserMessage {
  agent: AgentUserMessage;
}

/** Error text, completed with Claude Code's last stderr line if any. */
function errorMessage(error: unknown, run?: AgentRun): string {
  const message = error instanceof Error ? error.message : String(error);
  const detail = run?.stderrTail().at(-1);
  return detail && !message.includes(detail)
    ? `${message}: ${detail}`
    : message;
}

/** Default title: the first line of the first message, shortened. */
export function titleFromPrompt(prompt: string): string {
  const line = prompt.trim().split('\n')[0].trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** A session event together with the session it belongs to. */
export interface SessionEventEnvelope {
  sessionId: string;
  event: SessionEvent;
}

/** What a new subscriber gets. */
export interface SessionSnapshot extends LogSnapshot {
  session: SessionDto;
}

/**
 * In-memory state of a session in this server process. It exists while the
 * session has a process or subscribers and is released afterwards; the log
 * is then rebuilt from the transcript and the stored events when needed.
 */
interface LiveSession {
  id: string;
  run: AgentRun | null;
  /** Set while the session is prepared or a process is being started. */
  starting: Promise<void> | null;
  /** Stops a running preparation (the session was ended). */
  preparation: AbortController | null;
  mapper: SdkEventMapper;
  tracker: UsageTracker;
  log: SessionLog;
  historyLoaded: Promise<void> | null;
  /** Number of WebSocket subscriptions. */
  subscribers: number;
  /** Position in the transcript that new stored events are anchored to. */
  anchor: EventAnchor;
  context: ContextUsage | null;
  /** When the context usage was last requested during a turn. */
  contextRequestedAt: number;
  /**
   * Set when the running turn is being stopped: by the user (Stop; queued
   * messages are withdrawn) or by a denial without message (the queue
   * goes on).
   */
  interruptRequested: 'user' | 'denied' | null;
  /**
   * Messages sent while a turn runs; they go to Claude when it ends. Held
   * by the app (not Claude Code's own queue) so that they can be removed.
   */
  queue: QueuedMessage[];
  /** IDs of messages whose sending has begun (images being loaded). */
  sending: Set<string>;
  /** Status and `waitingFor` last published (`status/waitingFor`). */
  publishedStatus: string;
  /** Why the current process is being closed on purpose. */
  closing: 'idle' | 'shutdown' | 'end' | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Settles when the message loop of the current process has ended. */
  consuming: Promise<void> | null;
}

/** How long shutdown waits for Claude Code processes to exit. */
export const SHUTDOWN_GRACE_MS = 5000;

/** Notice stored when a server stop interrupts a running turn. */
export const RESTART_NOTICE =
  'The response was interrupted because the server stopped. Send a message to continue.';

/** Error of a session whose preparation a server stop cut off. */
export const PREPARATION_INTERRUPTED =
  'The preparation was interrupted because the server stopped; its directories were removed again. Start a new session.';

/** Notice when a session is ended before its first message reached Claude. */
export const ENDED_WHILE_PREPARING =
  'The session was ended before its first message was sent to Claude.';

/** Why queued messages were not sent. */
export const QUEUE_WITHDRAWN = {
  interrupted: 'The turn was stopped.',
  ended: 'The session was ended.',
  failed: 'Claude Code ended with an error.',
  restart: 'The server stopped.',
} as const;

/** Notice when the first message is held back after failed setup scripts. */
export function setupFailedNotice(repositories: string[]): string {
  return (
    `The setup script of ${repositories.join(', ')} failed, so the first message was not sent to Claude yet. ` +
    'Send it anyway, run the setup again, or end the session.'
  );
}

/**
 * Runs sessions: starts Claude Code processes, keeps them for follow-up
 * messages, turns their messages into session events, tracks status and
 * usage, and resumes sessions whose process has ended.
 */
@Injectable()
export class SessionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionsService.name);
  private readonly live = new Map<string, LiveSession>();
  private readonly events = new Subject<SessionEventEnvelope>();
  private readonly updates = new Subject<SessionDto>();
  private shuttingDown = false;

  /** Events of all sessions, as they are added to the session logs. */
  readonly events$ = this.events.asObservable();
  /** Sessions after any change of their metadata, status or usage. */
  readonly updates$ = this.updates.asObservable();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionRepository,
    private readonly usage: UsageRepository,
    private readonly storedEvents: SessionEventRepository,
    private readonly runner: AgentRunner,
    private readonly transcripts: TranscriptReader,
    private readonly limits: LimitsService,
    private readonly workspaces: SessionWorkspaceService,
    @Optional()
    private readonly approver: ToolApprover = new UserToolApprover(),
    @Optional()
    private readonly support: SessionAgentSupport = new NoSessionAgentSupport(),
    @Optional()
    private readonly files: SessionFileAccess = new SessionFileAccess(),
    // Not a union type: Nest injects by the parameter's declared class.
    @Optional()
    private readonly attachments?: AttachmentStore,
    @Optional()
    private readonly shownFiles?: ShownFilesService,
  ) {}

  /**
   * Sessions still marked running were cut off by a server stop that did not
   * shut down cleanly; they wait for the user again. Preparations that were
   * cut off are rolled back and their sessions marked failed.
   */
  async onModuleInit(): Promise<void> {
    for (const record of this.sessions.listByStatus('preparing')) {
      const anchor = {
        uuid: record.pendingMessage?.id ?? null,
        userId: record.pendingMessage?.id ?? null,
      };
      await this.workspaces.rollback(record.id, (event) =>
        this.storedEvents.add(record.id, event, anchor),
      );
      this.storedEvents.add(
        record.id,
        { type: 'error', message: PREPARATION_INTERRUPTED },
        anchor,
      );
      this.sessions.update(record.id, {
        status: 'failed',
        lastError: PREPARATION_INTERRUPTED,
      });
      this.logger.warn(`The preparation of ${record.id} was interrupted`);
    }
    const ids = this.sessions.stopRunningSessions();
    for (const id of ids) {
      // Where in the conversation is unknown: placed at the end.
      const anchor = { uuid: null, userId: null };
      this.closeLeftovers(id, (event) =>
        this.storedEvents.add(id, event, anchor),
      );
      this.storedEvents.add(
        id,
        { type: 'notice', level: 'warning', text: RESTART_NOTICE },
        anchor,
      );
    }
    if (ids.length > 0) {
      this.logger.log(`${ids.length} running session(s) were interrupted`);
    }
  }

  /**
   * Stops all Claude Code processes and waits (bounded) until they have
   * exited, so that their last transcript writes land and no process is left
   * behind. Runs before the database closes. Sessions keep their status;
   * a running turn is recorded as interrupted and the session waits.
   */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    const exits: Promise<void>[] = [];
    for (const live of this.live.values()) {
      this.clearIdleTimer(live);
      if (live.preparation) {
        // Stays `preparing`; rolled back on the next start.
        live.preparation.abort();
        if (live.starting) {
          exits.push(live.starting);
        }
        continue;
      }
      if (!live.run) {
        continue;
      }
      this.approver.cancelSession(live.id, 'restart');
      this.withdrawQueue(live, QUEUE_WITHDRAWN.restart);
      if (this.requireRecord(live.id).status === 'running') {
        this.append(live, {
          type: 'notice',
          level: 'warning',
          text: RESTART_NOTICE,
        });
        this.sessions.update(live.id, { status: 'waiting' });
      }
      live.closing = 'shutdown';
      live.run.close();
      if (live.consuming) {
        exits.push(live.consuming);
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SHUTDOWN_GRACE_MS);
    });
    const result = await Promise.race([
      Promise.allSettled(exits).then(() => 'done' as const),
      timeout,
    ]);
    clearTimeout(timer);
    if (result === 'timeout') {
      this.logger.warn('Claude Code processes did not exit in time');
    }
  }

  list(): SessionDto[] {
    const records = this.sessions.list();
    const totals = this.usage.totalsBySession();
    return records.map((record) =>
      this.toDto(record, totals.get(record.id) ?? { ...EMPTY_USAGE }),
    );
  }

  get(id: string): SessionDto {
    return this.toDto(this.requireRecord(id));
  }

  /**
   * Publishes the current state of a session after a change made outside
   * this service (push, pull request).
   */
  publishUpdate(id: string): void {
    const record = this.sessions.get(id);
    if (record) {
      this.updates.next(this.toDto(record));
    }
  }

  /**
   * Creates a session in status `preparing` and returns it; its clones (or
   * scratch directory) and setup scripts are prepared in the background,
   * then the prompt goes to Claude.
   */
  async create(request: CreateSessionRequest): Promise<SessionDto> {
    const body = requireObject(request);
    const { text: prompt, attachmentIds } = this.messageContent(body, 'prompt');
    const title =
      optionalString(body, 'title', { maxLength: MAX_TITLE_LENGTH })?.trim() ||
      titleFromPrompt(prompt) ||
      (attachmentIds.length === 1 ? 'Image' : 'Images');
    const model = optionalString(body, 'model')?.trim() || null;
    if (model && !MODEL_PATTERN.test(model)) {
      throw new BadRequestException('model is not a valid model name');
    }
    const permissionMode =
      optionalEnum(body, 'permissionMode', SESSION_PERMISSION_MODES) ??
      'default';

    this.attachmentStore(attachmentIds).check(attachmentIds);
    const plan = await this.workspaces.plan(request, title);
    const message = { id: randomUUID(), text: prompt };
    let record: SessionRecord;
    try {
      record = this.sessions.create({
        id: randomUUID(),
        title,
        model,
        permissionMode,
        status: 'preparing',
        slug: plan.slug,
        pendingMessage: message,
        directories: plan.directories,
      });
    } catch (error) {
      if (
        String((error as { code?: unknown }).code).startsWith(
          'SQLITE_CONSTRAINT',
        )
      ) {
        throw new ConflictException(
          'A session or project with this name was created at the same time; try again',
        );
      }
      throw error;
    }
    const attachments = this.attachmentStore(attachmentIds).claim(
      attachmentIds,
      record.id,
      message.id,
    );
    const live = this.liveSession(record.id);
    live.historyLoaded = Promise.resolve();
    this.append(live, {
      type: 'session.status',
      status: 'preparing',
      waitingFor: null,
    });
    this.appendUserMessage(live, { ...message, attachments });
    const dto = this.toDto(record);
    this.updates.next(dto);
    this.startPreparation(live, message);
    return dto;
  }

  /**
   * Sends a user message. Starts a turn, queues it behind the running turn
   * (it goes to Claude when the turn ends), or resumes the session if no
   * process is running.
   */
  async send(
    sessionId: string,
    message: { id?: string; text: string; attachmentIds?: string[] },
  ): Promise<void> {
    const body = requireObject(message);
    const { text, attachmentIds } = this.messageContent(body, 'text');
    // The ID goes to Claude Code as the message UUID.
    const id = optionalUuid(body, 'id') ?? randomUUID();
    const record = this.requireRecord(sessionId);
    this.requireUsable(record);
    const live = this.liveSession(sessionId);
    await this.ensureHistory(live, record);
    if (live.starting) {
      await live.starting;
    }
    if (this.isKnownMessage(live, id)) {
      // Sent twice (e.g. a retry after a reconnect).
      return;
    }
    // Marked until it is queued or sent: a second request with this ID
    // that arrives during the awaits below finds it here.
    live.sending.add(id);
    let attachments: AttachmentDto[];
    let agent: AgentUserMessage;
    try {
      attachments = this.attachmentStore(attachmentIds).claim(
        attachmentIds,
        sessionId,
        id,
      );
      agent = await this.agentMessage(sessionId, { id, text });
      if (live.starting) {
        await live.starting;
      }
    } finally {
      live.sending.delete(id);
    }
    // No await from here on until it is queued or sent.
    if (this.isKnownMessage(live, id)) {
      return;
    }
    if (live.run && this.requireRecord(sessionId).status === 'running') {
      live.queue.push({ id, text, attachments, agent });
      this.append(live, {
        type: 'message.queued',
        id,
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      return;
    }
    this.appendUserMessage(live, { id, text, attachments });
    if (live.run) {
      live.run.send(agent);
      this.setStatus(live, 'running');
    } else {
      this.setStatus(live, 'running');
      this.startRun(live, this.requireRecord(sessionId), { id, text });
    }
  }

  /** A message with this ID is queued, being sent, or in the log. */
  private isKnownMessage(live: LiveSession, id: string): boolean {
    return (
      live.sending.has(id) ||
      live.queue.some((queued) => queued.id === id) ||
      live.log.events.some(
        (event) => event.type === 'user.message' && event.id === id,
      )
    );
  }

  /**
   * Sends the pending first message although a setup script failed. The
   * message goes to Claude as it is; the setup output stays in the history.
   */
  async sendPending(sessionId: string): Promise<SessionDto> {
    const { live, message } = await this.pendingDecision(sessionId);
    this.track(live, () => this.deliverPending(live, message));
    return this.get(sessionId);
  }

  /**
   * Runs the failed setup scripts again; if they succeed, the pending first
   * message goes to Claude.
   */
  async rerunSetup(sessionId: string): Promise<SessionDto> {
    const { live, message } = await this.pendingDecision(sessionId);
    this.setStatus(live, 'preparing');
    this.runPreparation(live, message, (emit, signal) =>
      this.workspaces.rerunFailedSetup(live.id, emit, signal),
    );
    return this.get(sessionId);
  }

  /**
   * Removes a queued message before it goes to Claude. Fails with 409 when
   * it is not queued (anymore): it was sent already or withdrawn.
   */
  async unqueue(sessionId: string, messageId: string): Promise<void> {
    this.requireRecord(sessionId);
    const live = this.live.get(sessionId);
    const index = live?.queue.findIndex((queued) => queued.id === messageId);
    if (!live || index === undefined || index < 0) {
      throw new ConflictException(
        'The message is not queued: it was sent to Claude already or withdrawn',
      );
    }
    live.queue.splice(index, 1);
    this.append(live, {
      type: 'message.dequeued',
      id: messageId,
      outcome: 'removed',
      reason: null,
    });
  }

  /** Pending approval requests of a session, oldest first. */
  pendingPermissions(sessionId: string): PermissionRequestEvent[] {
    this.requireRecord(sessionId);
    const live = this.live.get(sessionId);
    const requests = new Set(
      this.approver.pendingRequests(sessionId).map((event) => event.requestId),
    );
    return (live?.log.events ?? []).filter(
      (event): event is PermissionRequestEvent =>
        event.type === 'permission.request' && requests.has(event.requestId),
    );
  }

  /**
   * Answers an approval request (from any client, or a notification).
   * Answering one that is resolved already changes nothing and returns how
   * it was resolved; an unknown request is 404.
   */
  async respondToPermission(
    sessionId: string,
    requestId: string,
    response: unknown,
  ): Promise<PermissionResponseResult> {
    this.requireRecord(sessionId);
    const resolution = this.approver.respond(sessionId, requestId, response);
    if (resolution) {
      const live = this.live.get(sessionId);
      const logged = live
        ? findResolution(live.log.events, requestId)
        : undefined;
      return {
        resolved: (logged ??
          resolution) as PermissionResponseResult['resolved'],
        alreadyResolved: false,
      };
    }
    const previous = await this.permissionResolution(sessionId, requestId);
    if (!previous) {
      throw new NotFoundException(
        `Approval request ${requestId} not found in session ${sessionId}`,
      );
    }
    return { resolved: previous, alreadyResolved: true };
  }

  /**
   * How an approval request was resolved, without answering it; `null`
   * while it is pending or when it is unknown.
   */
  async permissionResolution(
    sessionId: string,
    requestId: string,
  ): Promise<PermissionResponseResult['resolved'] | null> {
    const record = this.requireRecord(sessionId);
    const live = this.live.get(sessionId);
    let previous: PermissionResolvedInput | undefined;
    if (live) {
      await this.ensureHistory(live, record);
      previous = findResolution(live.log.events, requestId);
    } else {
      previous = findResolution(
        this.storedEvents.list(sessionId).map((stored) => stored.event),
        requestId,
      );
    }
    return previous
      ? ({
          seq: 0,
          at: null,
          ...previous,
        } as PermissionResponseResult['resolved'])
      : null;
  }

  /**
   * Changes the model or permission mode of a session. A running Claude
   * Code process switches right away (the model for its next request);
   * otherwise the next process starts with it.
   */
  async update(
    sessionId: string,
    request: UpdateSessionRequest,
  ): Promise<SessionDto> {
    const body = requireObject(request);
    const record = this.requireRecord(sessionId);
    let model: string | null | undefined;
    if ('model' in body) {
      model =
        body['model'] === null
          ? null
          : optionalString(body, 'model')?.trim() || null;
      if (model && !MODEL_PATTERN.test(model)) {
        throw new BadRequestException('model is not a valid model name');
      }
    }
    const permissionMode = optionalEnum(
      body,
      'permissionMode',
      SESSION_PERMISSION_MODES,
    );
    const changes: {
      model?: string | null;
      permissionMode?: SessionPermissionMode;
    } = {};
    if (model !== undefined && model !== record.model) {
      changes.model = model;
    }
    if (permissionMode && permissionMode !== record.permissionMode) {
      changes.permissionMode = permissionMode;
    }
    if (Object.keys(changes).length === 0) {
      return this.toDto(record);
    }
    const live = this.live.get(sessionId);
    if (live?.starting) {
      await live.starting;
    }
    const run = live?.run;
    if (run) {
      try {
        if (changes.permissionMode) {
          await run.setPermissionMode(changes.permissionMode);
        }
        if (changes.model !== undefined) {
          await run.setModel(changes.model);
        }
      } catch (error) {
        throw new ConflictException(
          `Claude Code did not accept the change: ${errorMessage(error)}`,
        );
      }
    }
    this.applySettings(sessionId, changes, 'user');
    if (run && live && changes.model !== undefined) {
      void this.refreshContext(live, run, { force: true });
    }
    return this.get(sessionId);
  }

  /** Stops the running turn of a session. */
  async interrupt(sessionId: string): Promise<void> {
    if (this.requireRecord(sessionId).status === 'preparing') {
      throw new ConflictException('The session is still being prepared');
    }
    const live = this.live.get(sessionId);
    if (live?.starting) {
      // The process is still starting; the interrupt applies to its turn.
      await live.starting;
    }
    const record = this.requireRecord(sessionId);
    if (!live?.run || record.status !== 'running') {
      throw new ConflictException('The session is not running');
    }
    live.interruptRequested = 'user';
    this.withdrawQueue(live, QUEUE_WITHDRAWN.interrupted);
    this.approver.cancelSession(sessionId, 'interrupted');
    await live.run.interrupt();
  }

  /**
   * Ends a session on request: stops its process and marks it finished. A
   * message to a finished session resumes it.
   */
  async end(sessionId: string): Promise<SessionDto> {
    const record = this.requireRecord(sessionId);
    let live = this.live.get(sessionId);
    // Stops setup scripts; clones being created are finished first.
    live?.preparation?.abort();
    if (live?.starting) {
      await live.starting;
    }
    if (live?.run) {
      live.closing = 'end';
      this.approver.cancelSession(sessionId, 'ended');
      this.withdrawQueue(live, QUEUE_WITHDRAWN.ended);
      live.run.close();
    }
    if (this.requireRecord(sessionId).pendingMessage) {
      // Waiting after a failed setup script: the message is dropped.
      live ??= this.liveSession(sessionId);
      await this.ensureHistory(live, record);
      this.sessions.update(sessionId, { pendingMessage: null });
      this.append(live, {
        type: 'notice',
        level: 'warning',
        text: ENDED_WHILE_PREPARING,
      });
    }
    if (live) {
      this.setStatus(live, 'finished');
      this.releaseIfUnused(live);
    } else if (record.status !== 'finished') {
      this.updates.next(
        this.toDto(this.sessions.update(sessionId, { status: 'finished' })),
      );
    }
    return this.get(sessionId);
  }

  /**
   * Registers a subscriber and returns the session with its log: complete,
   * or only the events after `after` if that log position is still valid.
   * Pair every successful call with {@link unsubscribe}.
   */
  async subscribe(
    sessionId: string,
    after?: LogPosition,
  ): Promise<SessionSnapshot> {
    const record = this.requireRecord(sessionId);
    const live = this.liveSession(sessionId);
    live.subscribers++;
    try {
      await this.ensureHistory(live, record);
    } catch (error) {
      this.unsubscribe(sessionId);
      throw error;
    }
    return {
      session: this.toDto(this.requireRecord(sessionId)),
      ...live.log.snapshot(after),
    };
  }

  unsubscribe(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (live) {
      live.subscribers = Math.max(0, live.subscribers - 1);
      this.releaseIfUnused(live);
    }
  }

  /** Number of sessions held in memory (for tests and diagnostics). */
  get liveCount(): number {
    return this.live.size;
  }

  // -------------------------------------------------------------------------

  private liveSession(id: string): LiveSession {
    let live = this.live.get(id);
    if (!live) {
      live = {
        id,
        run: null,
        starting: null,
        preparation: null,
        mapper: new SdkEventMapper(),
        tracker: new UsageTracker(),
        log: new SessionLog(),
        historyLoaded: null,
        subscribers: 0,
        anchor: { uuid: null, userId: null },
        context: null,
        contextRequestedAt: 0,
        interruptRequested: null,
        queue: [],
        sending: new Set(),
        publishedStatus: '',
        closing: null,
        idleTimer: null,
        consuming: null,
      };
      this.live.set(id, live);
      const record = this.sessions.get(id);
      if (record) {
        live.publishedStatus = statusKey(this.effectiveStatus(record));
      }
    }
    return live;
  }

  /**
   * Fills the event log of a session from the Claude Code transcript and the
   * stored app events, once per {@link LiveSession}.
   */
  private ensureHistory(
    live: LiveSession,
    record: SessionRecord,
  ): Promise<void> {
    live.historyLoaded ??= (async () => {
      let entries: ReturnType<typeof transcriptEntries> = [];
      let failed = false;
      if (record.sdkSessionId) {
        try {
          entries = transcriptEntries(
            await this.transcripts.read(
              record.sdkSessionId,
              workingDirectory(record),
            ),
          );
        } catch (error) {
          failed = true;
          this.logger.warn(
            `Could not read the transcript of ${record.id}: ${String(error)}`,
          );
        }
      }
      // Nothing else is logged before the history is loaded.
      const images = this.attachments?.forSession(record.id) ?? new Map();
      if (record.pendingMessage) {
        // Not sent to Claude (yet), so not in the transcript.
        live.log.append(
          withAttachments(
            { type: 'user.message', ...record.pendingMessage },
            images,
          ),
          record.createdAt.toISOString(),
        );
      }
      const history = withInputDiffs(
        buildHistory(entries, this.storedEvents.list(record.id)),
        (event, at) => ({ event, at }),
      );
      for (const item of history) {
        live.log.append(withAttachments(item.event, images), item.at);
      }
      if (failed) {
        // Live-only: the transcript may be readable next time.
        this.append(
          live,
          {
            type: 'notice',
            level: 'warning',
            text: 'The earlier conversation could not be loaded.',
          },
          { store: false },
        );
      }
      const lastUser = entries.findLast((entry) => entry.isUserMessage);
      live.anchor = {
        uuid: entries.at(-1)?.uuid ?? null,
        userId: lastUser?.uuid ?? null,
      };
      live.context = live.log.findLast('context.usage')?.context ?? null;
    })();
    return live.historyLoaded;
  }

  /** Runs a start-up task (preparation, process start) as `starting`. */
  private track(live: LiveSession, task: () => Promise<void>): void {
    live.starting = (async () => {
      try {
        await task();
      } finally {
        live.starting = null;
      }
      if (!live.run) {
        this.releaseIfUnused(live);
      }
    })();
  }

  /**
   * Prepares the directories of a new session, then sends the first
   * message. Ending the session meanwhile stops the setup scripts and keeps
   * the message from being sent.
   */
  /**
   * Prepares the directories of a new session, then sends the first
   * message. Ending the session meanwhile stops the setup scripts and keeps
   * the message from being sent.
   */
  private startPreparation(
    live: LiveSession,
    message: { id: string; text: string },
  ): void {
    this.runPreparation(live, message, (emit, signal) =>
      this.workspaces.prepare(live.id, emit, signal),
    );
  }

  /**
   * Runs a preparation task (create directories and run setup scripts, or
   * re-run failed setup scripts). Afterwards the first message goes to
   * Claude; if a setup script failed, the session waits with the message
   * pending until the user decides.
   */
  private runPreparation(
    live: LiveSession,
    message: { id: string; text: string },
    task: (
      emit: (event: SessionEventInput) => void,
      signal: AbortSignal,
    ) => Promise<SetupOutcome>,
  ): void {
    const preparation = new AbortController();
    live.preparation = preparation;
    this.track(live, async () => {
      let outcome: SetupOutcome;
      try {
        outcome = await task(
          (event) => this.append(live, event),
          preparation.signal,
        );
      } catch (error) {
        live.preparation = null;
        if (!this.shuttingDown) {
          this.failRun(live, error);
        }
        return;
      }
      live.preparation = null;
      if (this.shuttingDown) {
        return;
      }
      if (preparation.signal.aborted) {
        this.sessions.update(live.id, { pendingMessage: null });
        this.append(live, {
          type: 'notice',
          level: 'warning',
          text: ENDED_WHILE_PREPARING,
        });
        return;
      }
      if (outcome.failed.length > 0) {
        this.append(live, {
          type: 'notice',
          level: 'warning',
          text: setupFailedNotice(outcome.failed),
        });
        this.setStatus(live, 'waiting');
        return;
      }
      this.append(live, {
        type: 'prepare.progress',
        step: 'done',
        state: 'succeeded',
        target: null,
        path: null,
        message: null,
      });
      await this.deliverPending(live, message);
    });
  }

  /** Sends the pending first message to Claude. */
  private async deliverPending(
    live: LiveSession,
    message: { id: string; text: string },
  ): Promise<void> {
    const record = this.sessions.update(live.id, { pendingMessage: null });
    this.setStatus(live, 'running');
    await this.launch(live, record, message);
  }

  private startRun(
    live: LiveSession,
    record: SessionRecord,
    firstMessage: { id: string; text: string },
  ): void {
    this.track(live, () => this.launch(live, record, firstMessage));
  }

  /** Starts a Claude Code process with the first message of its run. */
  private async launch(
    live: LiveSession,
    record: SessionRecord,
    firstMessage: { id: string; text: string },
  ): Promise<void> {
    this.clearIdleTimer(live);
    live.mapper = new SdkEventMapper();
    live.tracker = new UsageTracker(this.usage.totalsByModel(record.id));
    live.interruptRequested = null;
    live.closing = null;
    try {
      const extras = await this.support.prepare(record);
      // What the user allowed for the session applies to every process.
      const allowed = sessionAllows(this.storedEvents.list(record.id));
      const directories = additionalDirectories(record);
      const run = await this.runner.start(
        {
          cwd: workingDirectory(record),
          additionalDirectories: [
            ...directories,
            ...allowed.directories.filter(
              (directory) =>
                !directories.includes(directory) &&
                directory !== workingDirectory(record),
            ),
          ],
          model: record.model,
          permissionMode: record.permissionMode,
          ...(await this.resumeTarget(record)),
          canUseTool: this.canUseTool(live),
          allowedTools: [...allowed.rules, ...(extras.allowedTools ?? [])],
          env: { ...SESSION_ENV, ...extras.env },
          tools: extras.tools,
          settings: extras.settings,
        },
        await this.agentMessage(live.id, firstMessage),
      );
      live.run = run;
      live.consuming = this.consume(live, run);
    } catch (error) {
      this.support.released(live.id);
      this.failRun(live, error);
    }
  }

  /**
   * New sessions use their own ID as Claude Code session ID. If an earlier
   * start died before Claude Code reported the ID, a transcript with that ID
   * may already exist, and Claude Code refuses to reuse it ("Session ID ...
   * is already in use"); then the session is resumed instead.
   */
  private async resumeTarget(
    record: SessionRecord,
  ): Promise<{ resume: string | null; sessionId: string | null }> {
    if (record.sdkSessionId) {
      return { resume: record.sdkSessionId, sessionId: null };
    }
    let exists = false;
    try {
      exists = await this.transcripts.exists(
        record.id,
        workingDirectory(record),
      );
    } catch (error) {
      this.logger.warn(`Transcript lookup failed: ${String(error)}`);
    }
    return exists
      ? { resume: record.id, sessionId: null }
      : { resume: null, sessionId: record.id };
  }

  private async consume(live: LiveSession, run: AgentRun): Promise<void> {
    let failure: unknown = null;
    try {
      for await (const message of run.messages) {
        if (live.run !== run) {
          break;
        }
        try {
          this.handleMessage(live, message);
        } catch (error) {
          this.logger.error(`Handling a message of ${live.id} failed`, error);
        }
      }
    } catch (error) {
      failure = error;
    }
    if (live.run === run || this.shuttingDown) {
      // The process is gone: its token and approvals end with it.
      this.support.released(live.id);
    }
    if (live.run !== run || this.shuttingDown) {
      return;
    }
    // Nobody can answer into the ended process any more.
    this.approver.cancelSession(live.id, 'process_exit');
    live.run = null;
    live.consuming = null;
    this.clearIdleTimer(live);
    live.log.clearDrafts();
    const status = this.requireRecord(live.id).status;
    if (live.closing) {
      // Closed on purpose (idle timeout or end): the status stays.
    } else if (status === 'running') {
      // The process ended in the middle of a turn.
      this.failRun(
        live,
        failure ??
          new Error('Claude Code ended unexpectedly while a turn was running'),
        run,
      );
    } else if (failure) {
      // Ended while waiting; the next message starts a new process.
      this.logger.warn(
        `Claude Code of ${live.id} ended while waiting: ${errorMessage(failure, run)}`,
      );
    }
    live.closing = null;
    this.releaseIfUnused(live);
  }

  /** Forgets a session without process and subscribers. */
  private releaseIfUnused(live: LiveSession): void {
    if (
      live.subscribers === 0 &&
      !live.run &&
      !live.starting &&
      !this.shuttingDown &&
      this.live.get(live.id) === live
    ) {
      this.live.delete(live.id);
    }
  }

  private handleMessage(live: LiveSession, message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      const record = this.requireRecord(live.id);
      if (record.sdkSessionId !== message.session_id) {
        this.updates.next(
          this.toDto(
            this.sessions.update(live.id, { sdkSessionId: message.session_id }),
          ),
        );
      }
      if (message.permissionMode) {
        this.syncPermissionMode(live, message.permissionMode);
      }
      return;
    }
    if (
      message.type === 'system' &&
      message.subtype === 'status' &&
      message.permissionMode
    ) {
      // Claude Code changed the mode itself (e.g. entering plan mode).
      this.syncPermissionMode(live, message.permissionMode);
    }
    if (message.type === 'rate_limit_event') {
      this.limits.updateFromRateLimitEvent(message.rate_limit_info);
      return;
    }
    if (message.type === 'result') {
      this.handleResult(live, message);
      return;
    }
    const events = live.mapper.map(message);
    if (
      (message.type === 'assistant' || message.type === 'user') &&
      message.uuid
    ) {
      // Stored events that follow belong after this transcript entry.
      live.anchor = { ...live.anchor, uuid: message.uuid };
    }
    for (const event of events) {
      this.append(live, event);
    }
    this.showImages(live, live.mapper.takeImages());
    if (message.type === 'assistant' && live.run) {
      // Live context usage during long turns (no API request involved).
      void this.refreshContext(live, live.run);
    }
  }

  private handleResult(
    live: LiveSession,
    result: Extract<SDKMessage, { type: 'result' }>,
  ): void {
    const record = this.requireRecord(live.id);
    const byModel = live.tracker.consume(result.modelUsage);
    this.usage.record(
      live.id,
      result.session_id ?? record.sdkSessionId,
      byModel,
    );
    const stop = live.interruptRequested;
    const interrupted = stop !== null;
    live.interruptRequested = null;
    const errors = result.subtype === 'success' ? [] : result.errors;
    this.append(live, {
      type: 'turn.result',
      subtype: result.subtype,
      isError: result.is_error,
      interrupted,
      durationMs: result.duration_ms,
      numTurns: result.num_turns,
      usage: sumUsage(Object.values(byModel)),
      errors,
    });
    if (!interrupted) {
      if (result.subtype === 'success' && result.is_error) {
        // API errors usually arrive as assistant text already; do not
        // repeat the same text.
        if (live.log.lastAssistantText !== result.result) {
          this.append(live, {
            type: 'error',
            message: result.result || 'The request failed.',
          });
        }
      } else if (result.subtype !== 'success') {
        this.append(live, {
          type: 'error',
          message:
            errors.join('\n') || `The turn ended early (${result.subtype}).`,
        });
      }
    }
    const run = live.run;
    // Queued messages go to Claude now (Claude Code may take them as one
    // turn); after the user stopped the turn they were withdrawn already.
    const flushed = run && stop !== 'user' ? this.flushQueue(live, run) : 0;
    const queued = flushed > 0 || (result.queued_turn_count ?? 0) > 0;
    if (!this.setStatus(live, queued ? 'running' : 'waiting')) {
      // Usage changed even if the status did not.
      this.updates.next(this.toDto(this.requireRecord(live.id)));
    }
    if (run) {
      void this.refreshContext(live, run, { force: true });
      void this.limits.refreshPlanUsage(() => run.planUsage());
    }
  }

  /**
   * Shows images Claude read or wrote as thumbnails on their tool call
   * (through the shown files, whose events come back via
   * {@link recordEvent}).
   */
  private showImages(live: LiveSession, images: SeenImage[]): void {
    const store = this.shownFiles;
    if (!store) {
      return;
    }
    for (const image of images) {
      const shown =
        image.kind === 'read'
          ? store.fromData(
              live.id,
              image.toolUseId,
              image.path,
              image.data,
              'read',
            )
          : store.show(live.id, image.toolUseId, image.path, null, 'write');
      shown.catch((error: unknown) =>
        this.logger.warn(
          `Could not keep the image ${image.path} of ${live.id}: ${String(error)}`,
        ),
      );
    }
  }

  /**
   * Adds an event that happened outside the session's process (a file
   * shown by the app's tool) to its log, or stores it when the session is
   * not in memory.
   */
  recordEvent(sessionId: string, event: SessionEventInput): void {
    const live = this.live.get(sessionId);
    if (live) {
      this.append(live, event);
    } else if (this.sessions.get(sessionId)) {
      this.storedEvents.add(sessionId, event, { uuid: null, userId: null });
    }
  }

  /** Sends all queued messages to Claude; returns how many. */
  private flushQueue(live: LiveSession, run: AgentRun): number {
    const messages = live.queue.splice(0);
    for (const message of messages) {
      this.append(live, {
        type: 'message.dequeued',
        id: message.id,
        outcome: 'sent',
        reason: null,
      });
      this.appendUserMessage(live, message);
      run.send(message.agent);
    }
    return messages.length;
  }

  /** Drops the queued messages; the user sees them as not sent. */
  private withdrawQueue(live: LiveSession, reason: string): void {
    for (const message of live.queue.splice(0)) {
      this.append(live, {
        type: 'message.dequeued',
        id: message.id,
        outcome: 'withdrawn',
        reason,
      });
    }
  }

  /**
   * After a crash: approval requests and queued messages that were open
   * when the server stopped are closed (their process is gone).
   */
  private closeLeftovers(
    sessionId: string,
    add: (event: SessionEventInput) => void,
  ): void {
    const stored = this.storedEvents.list(sessionId);
    for (const request of unresolvedRequests(stored)) {
      add({
        type: 'permission.resolved',
        requestId: request.requestId,
        toolUseId: request.toolUseId,
        decision: 'deny',
        scope: null,
        cause: 'restart',
        message: null,
        answers: null,
        mode: null,
        sessionAllow: null,
      });
    }
    const queued = new Map<string, true>();
    for (const { event } of stored) {
      if (event.type === 'message.queued') {
        queued.set(event.id, true);
      } else if (event.type === 'message.dequeued') {
        queued.delete(event.id);
      }
    }
    for (const id of queued.keys()) {
      add({
        type: 'message.dequeued',
        id,
        outcome: 'withdrawn',
        reason: QUEUE_WITHDRAWN.restart,
      });
    }
  }

  /** Records a mode Claude Code reports, if it is one this app uses. */
  private syncPermissionMode(live: LiveSession, mode: PermissionMode): void {
    const record = this.requireRecord(live.id);
    if (
      mode === record.permissionMode ||
      !SESSION_PERMISSION_MODES.includes(mode as SessionPermissionMode)
    ) {
      if (!SESSION_PERMISSION_MODES.includes(mode as SessionPermissionMode)) {
        this.logger.warn(
          `Claude Code of ${live.id} reports permission mode ${mode}, which this app does not use`,
        );
      }
      return;
    }
    this.applySettings(
      live.id,
      { permissionMode: mode as SessionPermissionMode },
      'claude',
    );
  }

  /** Stores a model or mode change, logs it and publishes the session. */
  private applySettings(
    sessionId: string,
    changes: { model?: string | null; permissionMode?: SessionPermissionMode },
    cause: 'user' | 'plan' | 'claude',
  ): void {
    const updated = this.sessions.update(sessionId, changes);
    const live = this.live.get(sessionId);
    if (live) {
      this.append(live, { type: 'settings.changed', ...changes, cause });
    } else {
      this.storedEvents.add(
        sessionId,
        { type: 'settings.changed', ...changes, cause },
        { uuid: null, userId: null },
      );
    }
    this.updates.next(this.toDto(updated));
  }

  /**
   * Reads the context window usage from Claude Code (no API request). After
   * a turn (`force`) it is stored; during a turn at most every
   * {@link CONTEXT_REFRESH_INTERVAL_MS}, live only.
   */
  private async refreshContext(
    live: LiveSession,
    run: AgentRun,
    { force = false }: { force?: boolean } = {},
  ): Promise<void> {
    const now = Date.now();
    if (!force && now - live.contextRequestedAt < CONTEXT_REFRESH_INTERVAL_MS) {
      return;
    }
    live.contextRequestedAt = now;
    try {
      const usage = await run.contextUsage();
      if (live.run !== run) {
        return;
      }
      live.context = {
        model: usage.model,
        usedTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        percentage: usage.percentage,
        updatedAt: new Date().toISOString(),
      };
      this.append(
        live,
        { type: 'context.usage', context: live.context },
        { store: force },
      );
    } catch (error) {
      this.logger.warn(
        `Context usage of ${live.id} unavailable: ${String(error)}`,
      );
    }
  }

  /**
   * Tool uses that need approval become approval requests the user
   * answers (see {@link ToolApprover}); the session waits for the user
   * meanwhile. Approved uses are reported to the integrations: an approved
   * `git push` or `create_pull_request` call is what lets those through.
   */
  private canUseTool(live: LiveSession): CanUseTool {
    return async (toolName, input, options) => {
      if (
        toolName === SHOW_FILE_TOOL_NAME &&
        (!options.mcpServer ||
          (options.mcpServer.name === APP_MCP_SERVER &&
            options.mcpServer.source === 'sdk'))
      ) {
        // Reads only inside the session's directories: never asks.
        return { behavior: 'allow', updatedInput: input };
      }
      const command =
        toolName === 'Bash' && typeof input['command'] === 'string'
          ? input['command']
          : null;
      const mcpServer = options.mcpServer ?? null;
      const gitPushes = command
        ? await this.workspaces.analyzeGitPushes(live.id, command)
        : [];
      const decision = await this.approver.decide({
        sessionId: live.id,
        toolName,
        input,
        gitPushes,
        pullRequest:
          toolName === CREATE_PULL_REQUEST_TOOL_NAME &&
          (mcpServer === null || mcpServer.source === 'sdk')
            ? this.pullRequestCall(live.id, input)
            : null,
        diff: await this.proposedChange(live.id, toolName, input),
        toolUseId: options.toolUseID,
        title: options.title ?? null,
        description: options.description ?? null,
        displayName: options.displayName ?? null,
        decisionReason: options.decisionReason ?? null,
        blockedPath: options.blockedPath ?? null,
        agentId: options.agentID ?? null,
        mcpServer,
        suggestions: options.suggestions ?? [],
        suppressAlwaysAllow: options.suppressAlwaysAllowRule === true,
        signal: options.signal,
        onRequest: (event) => {
          this.append(live, event);
          this.publishStatus(live);
        },
        onResolve: (event) => {
          this.append(live, event);
          this.publishStatus(live);
        },
      });
      const { resolution, ...result } = decision;
      if (result.behavior === 'deny') {
        if (result.interrupt && live.run) {
          // The turn ends; queued messages still go to Claude afterwards.
          live.interruptRequested ??= 'denied';
        }
        return result;
      }
      const approvedInput = result.updatedInput ?? input;
      if (
        resolution.mode &&
        resolution.mode !== this.requireRecord(live.id).permissionMode
      ) {
        // Only an approved plan switches the mode (session-wide allows never
        // include a mode switch).
        this.applySettings(
          live.id,
          { permissionMode: resolution.mode },
          'plan',
        );
      }
      this.support.approved(
        live.id,
        toolName,
        approvedInput,
        options.toolUseID,
        mcpServer,
      );
      return { ...result, updatedInput: approvedInput };
    };
  }

  /**
   * The change a file tool call would make, for its approval: against the
   * file's current content when it is a text file inside the session's
   * directories (read as the session user), otherwise from the input.
   */
  private async proposedChange(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<FileDiff | null> {
    const path = changedFile(toolName, input);
    if (!path) {
      return null;
    }
    let current: string | null | undefined;
    try {
      const file = await this.files.read(
        this.readyDirectories(sessionId),
        path,
        PROPOSED_DIFF_MAX_BYTES,
      );
      current =
        file.truncated || file.data.includes(0)
          ? undefined
          : file.data.toString('utf8');
    } catch (error) {
      current =
        error instanceof FileAccessError && error.code === 'not_found'
          ? null
          : undefined;
    }
    try {
      return proposedDiff(toolName, input, current);
    } catch (error) {
      this.logger.warn(`Could not diff ${path}: ${String(error)}`);
      return null;
    }
  }

  /** Paths of a session's directories that exist. */
  private readyDirectories(sessionId: string): string[] {
    return this.requireRecord(sessionId)
      .directories.filter((directory) => directory.state === 'ready')
      .map((directory) => directory.path);
  }

  /**
   * A `create_pull_request` call as the approval shows it: the repository
   * and base branch the tool would use when Claude omitted them.
   */
  private pullRequestCall(
    sessionId: string,
    input: Record<string, unknown>,
  ): PullRequestCall {
    const text = (name: string) =>
      typeof input[name] === 'string' ? (input[name] as string) : null;
    const record = this.requireRecord(sessionId);
    const clones = record.directories.filter(
      (directory) => directory.kind === 'clone' && directory.repositoryGitHub,
    );
    const named = text('repository');
    const clone = named
      ? clones.find(
          (directory) =>
            directory.repositoryName?.toLowerCase() === named.toLowerCase(),
        )
      : clones.length === 1
        ? clones[0]
        : undefined;
    return {
      repository: named ?? clone?.repositoryName ?? null,
      title: text('title') ?? '',
      body: text('body'),
      base: text('base') ?? clone?.baseBranch ?? null,
      draft: input['draft'] === true,
    };
  }

  private failRun(live: LiveSession, error: unknown, run?: AgentRun): void {
    live.run = null;
    this.approver.cancelSession(live.id, 'process_exit');
    this.withdrawQueue(live, QUEUE_WITHDRAWN.failed);
    const message = errorMessage(error, run);
    this.logger.error(`Session ${live.id} failed: ${message}`);
    this.append(live, { type: 'error', message });
    this.setStatus(live, 'failed', message);
  }

  /**
   * Sets the status; `lastError` is kept only while the session is failed.
   * Returns whether anything changed.
   */
  private setStatus(
    live: LiveSession,
    status: SessionStatus,
    error?: string,
  ): boolean {
    const record = this.requireRecord(live.id);
    const lastError = status === 'failed' ? (error ?? record.lastError) : null;
    if (record.status === status && record.lastError === lastError) {
      return false;
    }
    const updated = this.sessions.update(live.id, { status, lastError });
    if (status === 'waiting') {
      this.startIdleTimer(live);
    } else {
      this.clearIdleTimer(live);
    }
    if (!this.publishStatus(live)) {
      this.updates.next(this.toDto(updated));
    }
    return true;
  }

  /**
   * Status as clients see it: a running turn that waits for an approval
   * request is `waiting` for `permission` (the stored status stays
   * `running`: the turn and its process go on).
   */
  private effectiveStatus(record: SessionRecord): {
    status: SessionStatus;
    waitingFor: SessionWaitingFor | null;
  } {
    if (record.status === 'running' && this.approver.hasPending(record.id)) {
      return { status: 'waiting', waitingFor: 'permission' };
    }
    if (record.status === 'waiting') {
      return {
        status: 'waiting',
        waitingFor: record.pendingMessage ? 'setup' : 'message',
      };
    }
    return { status: record.status, waitingFor: null };
  }

  /**
   * Logs and publishes the status when what clients see changed. Returns
   * whether it did.
   */
  private publishStatus(live: LiveSession): boolean {
    const record = this.requireRecord(live.id);
    const effective = this.effectiveStatus(record);
    const key = statusKey(effective);
    if (key === live.publishedStatus) {
      return false;
    }
    live.publishedStatus = key;
    this.append(live, { type: 'session.status', ...effective });
    this.updates.next(this.toDto(record));
    return true;
  }

  private startIdleTimer(live: LiveSession): void {
    this.clearIdleTimer(live);
    if (this.config.sessionIdleTimeoutMs <= 0) {
      return;
    }
    live.idleTimer = setTimeout(() => {
      live.idleTimer = null;
      if (live.run && this.requireRecord(live.id).status === 'waiting') {
        this.logger.log(`Closing idle session ${live.id}`);
        live.closing = 'idle';
        live.run.close();
      }
    }, this.config.sessionIdleTimeoutMs);
    live.idleTimer.unref?.();
  }

  private clearIdleTimer(live: LiveSession): void {
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = null;
    }
  }

  /**
   * Adds an event to the session log, stores it if it is not part of the
   * transcript, and publishes it.
   */
  private append(
    live: LiveSession,
    input: SessionEventInput,
    { store = true }: { store?: boolean } = {},
  ): void {
    const event = live.log.append(input);
    if (store && STORED_EVENT_TYPES.has(input.type)) {
      this.storedEvents.add(live.id, input, live.anchor);
    }
    if (input.type === 'tool.result') {
      this.support.toolFinished(live.id, input.toolUseId);
    }
    this.events.next({ sessionId: live.id, event });
  }

  private appendUserMessage(live: LiveSession, message: UserMessage): void {
    this.append(live, {
      type: 'user.message',
      id: message.id,
      text: message.text,
      ...(message.attachments.length > 0
        ? { attachments: message.attachments }
        : {}),
    });
    // Claude Code uses the message ID as the transcript entry's UUID.
    live.anchor = { uuid: message.id, userId: message.id };
  }

  /**
   * Text and images of a message: the text may be empty when images are
   * attached.
   */
  private messageContent(
    body: Record<string, unknown>,
    field: 'text' | 'prompt',
  ): { text: string; attachmentIds: string[] } {
    const attachmentIds = optionalUuidArray(
      body,
      'attachmentIds',
      MAX_ATTACHMENTS_PER_MESSAGE,
    );
    const text = optionalString(body, field, { maxLength: MAX_MESSAGE_LENGTH });
    if (text === undefined && attachmentIds.length === 0) {
      throw new BadRequestException(`${field} must be a string`);
    }
    if (!text?.trim() && attachmentIds.length === 0) {
      throw new BadRequestException(`${field} must not be blank`);
    }
    return { text: text ?? '', attachmentIds };
  }

  /** The attachment store, required when a message names attachments. */
  private attachmentStore(
    ids: string[],
  ): Pick<AttachmentStore, 'check' | 'claim'> {
    if (this.attachments) {
      return this.attachments;
    }
    if (ids.length > 0) {
      throw new BadRequestException('Attachments are not available');
    }
    return { check: () => undefined, claim: () => [] };
  }

  /** A message as Claude Code gets it, with its images. */
  private async agentMessage(
    sessionId: string,
    message: { id: string; text: string },
  ): Promise<AgentUserMessage> {
    const images =
      (await this.attachments?.agentImages(sessionId, message.id)) ?? [];
    return images.length > 0 ? { ...message, images } : { ...message };
  }

  /**
   * Refuses messages while the session is prepared, and for sessions whose
   * directories are not all there (failed preparation, removed clones).
   */
  private requireUsable(record: SessionRecord): void {
    if (record.status === 'preparing') {
      throw new ConflictException(
        'The session is still being prepared; send the message when it is ready',
      );
    }
    if (record.directories.some((directory) => directory.state !== 'ready')) {
      throw new ConflictException(
        "The session's directories are not available (not created or removed); start a new session",
      );
    }
    if (record.pendingMessage) {
      throw new ConflictException(
        'The first message has not been sent because a setup script failed: send it anyway, run the setup again, or end the session',
      );
    }
  }

  /** A session waiting with its first message after a failed setup script. */
  private async pendingDecision(
    sessionId: string,
  ): Promise<{ live: LiveSession; message: { id: string; text: string } }> {
    const record = this.requireRecord(sessionId);
    if (!record.pendingMessage || record.status !== 'waiting') {
      throw new ConflictException(
        'The session has no first message waiting for a decision',
      );
    }
    const live = this.liveSession(sessionId);
    await this.ensureHistory(live, record);
    return { live, message: record.pendingMessage };
  }

  private requireRecord(id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (!record) {
      throw new NotFoundException(`Session ${id} not found`);
    }
    return record;
  }

  private toDto(
    record: SessionRecord,
    totals = this.usage.totalsForSession(record.id),
  ): SessionDto {
    return {
      id: record.id,
      sdkSessionId: record.sdkSessionId,
      title: record.title,
      model: record.model,
      permissionMode: record.permissionMode,
      ...this.effectiveStatus(record),
      slug: record.slug,
      pendingMessage: record.pendingMessage?.text ?? null,
      directories: record.directories.map(
        (directory): SessionDirectoryDto => ({
          role: directory.position === 0 ? 'main' : 'additional',
          kind: directory.kind,
          path: directory.path,
          state: directory.state,
          repository:
            directory.repositoryId && directory.repositoryName
              ? {
                  id: directory.repositoryId,
                  fullName: directory.repositoryName,
                  local: directory.repositoryLocal,
                  github: directory.repositoryGitHub,
                }
              : null,
          branch: directory.branch,
          baseBranch: directory.baseBranch,
          baseCommit: directory.baseCommit,
          setupStatus: directory.setupStatus,
          pushedCommit: directory.pushedCommit,
          pushedAt: directory.pushedAt?.toISOString() ?? null,
        }),
      ),
      cwd: workingDirectory(record),
      additionalDirectories: additionalDirectories(record),
      lastError: record.lastError,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      usage: totals,
      context: this.live.get(record.id)?.context ?? null,
      pullRequests: record.pullRequests.map(pullRequestDto),
    };
  }
}

const statusKey = (status: {
  status: SessionStatus;
  waitingFor: SessionWaitingFor | null;
}) => `${status.status}/${status.waitingFor ?? ''}`;

/** The last resolution of an approval request in a list of events. */
function findResolution(
  events: readonly { type: string }[],
  requestId: string,
): PermissionResolvedInput | undefined {
  return events.findLast(
    (event): event is PermissionResolvedInput =>
      event.type === 'permission.resolved' &&
      (event as PermissionResolvedInput).requestId === requestId,
  );
}

/** A user message event with its images from the attachment store. */
function withAttachments(
  event: SessionEventInput,
  images: Map<string, AttachmentDto[]>,
): SessionEventInput {
  if (event.type !== 'user.message') {
    return event;
  }
  const attachments = images.get(event.id);
  return attachments ? { ...event, attachments } : event;
}
