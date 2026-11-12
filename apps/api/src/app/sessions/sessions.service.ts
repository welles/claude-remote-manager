import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Subject } from 'rxjs';
import type { CanUseTool, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  SESSION_PERMISSION_MODES,
  type ContextUsage,
  type CreateSessionRequest,
  type LogPosition,
  type SessionDto,
  type SessionEvent,
  type SessionEventInput,
  type SessionStatus,
} from '@claude-remote-manager/shared-types';
import { AgentRunner, type AgentRun } from '../agent/agent-runner';
import {
  optionalEnum,
  optionalString,
  optionalUuid,
  requireObject,
  requireString,
} from '../common/validation';
import { TranscriptReader } from '../agent/transcript-reader';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { LimitsService } from '../limits/limits.service';
import { SdkEventMapper, transcriptEntries } from './sdk-event-mapper';
import {
  SessionEventRepository,
  STORED_EVENT_TYPES,
  type EventAnchor,
} from './session-event.repository';
import { buildHistory, SessionLog, type LogSnapshot } from './session-log';
import { SessionRepository, type SessionRecord } from './session.repository';
import { EMPTY_USAGE, UsageRepository } from './usage.repository';
import { sumUsage, UsageTracker } from './usage-tracker';

/** What Claude is told, and the user shown, when a tool use needs approval. */
export const NO_APPROVAL_UI_MESSAGE =
  'Approval dialogs are not implemented in Claude Remote Manager yet, so this ' +
  'tool use was denied automatically. Continue without it if you can, ' +
  'otherwise tell the user what you wanted to do.';

const MAX_MESSAGE_LENGTH = 100_000;
const MAX_TITLE_LENGTH = 200;
const MODEL_PATTERN = /^[\w.[\]-]{1,100}$/;

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
  /** Set while a process is being started. */
  starting: Promise<void> | null;
  mapper: SdkEventMapper;
  tracker: UsageTracker;
  log: SessionLog;
  historyLoaded: Promise<void> | null;
  /** Number of WebSocket subscriptions. */
  subscribers: number;
  /** Position in the transcript that new stored events are anchored to. */
  anchor: EventAnchor;
  context: ContextUsage | null;
  interruptRequested: boolean;
  /** Why the current process is being closed on purpose. */
  closing: 'idle' | 'shutdown' | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
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
  ) {}

  onModuleInit(): void {
    const count = this.sessions.finishActiveSessions();
    if (count > 0) {
      this.logger.log(
        `Marked ${count} session(s) of the previous run as finished`,
      );
    }
  }

  /** Stops all Claude Code processes; runs before the database closes. */
  onModuleDestroy(): void {
    this.shuttingDown = true;
    for (const live of this.live.values()) {
      if (live.idleTimer) {
        clearTimeout(live.idleTimer);
      }
      if (live.run) {
        live.closing = 'shutdown';
        live.run.close();
        live.run = null;
        this.sessions.update(live.id, { status: 'finished' });
      }
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

  async create(request: CreateSessionRequest): Promise<SessionDto> {
    const body = requireObject(request);
    const prompt = requireString(body, 'prompt', {
      notBlank: true,
      maxLength: MAX_MESSAGE_LENGTH,
    });
    const title =
      optionalString(body, 'title', { maxLength: MAX_TITLE_LENGTH })?.trim() ||
      titleFromPrompt(prompt);
    const model = optionalString(body, 'model')?.trim() || null;
    if (model && !MODEL_PATTERN.test(model)) {
      throw new BadRequestException('model is not a valid model name');
    }
    const permissionMode =
      optionalEnum(body, 'permissionMode', SESSION_PERMISSION_MODES) ??
      'default';

    await mkdir(this.config.sessionCwd, { recursive: true });
    const record = this.sessions.create({
      id: randomUUID(),
      title,
      model,
      permissionMode,
      status: 'running',
      cwd: this.config.sessionCwd,
      additionalDirectories: this.config.sessionAdditionalDirectories,
    });
    const live = this.liveSession(record.id);
    live.historyLoaded = Promise.resolve();
    this.append(live, { type: 'session.status', status: 'running' });
    const message = { id: randomUUID(), text: prompt };
    this.appendUserMessage(live, message);
    const dto = this.toDto(record);
    this.updates.next(dto);
    this.startRun(live, record, message);
    return dto;
  }

  /**
   * Sends a user message. Starts a turn, queues it behind the running turn,
   * or resumes the session if no process is running.
   */
  async send(
    sessionId: string,
    message: { id?: string; text: string },
  ): Promise<void> {
    const body = requireObject(message);
    const text = requireString(body, 'text', {
      notBlank: true,
      maxLength: MAX_MESSAGE_LENGTH,
    });
    // The ID goes to Claude Code as the message UUID.
    const id = optionalUuid(body, 'id') ?? randomUUID();
    const record = this.requireRecord(sessionId);
    const live = this.liveSession(sessionId);
    await this.ensureHistory(live, record);
    if (live.starting) {
      await live.starting;
    }
    this.appendUserMessage(live, { id, text });
    if (live.run) {
      live.run.send({ id, text });
      this.setStatus(live, 'running');
    } else {
      this.setStatus(live, 'running');
      this.startRun(live, this.requireRecord(sessionId), { id, text });
    }
  }

  /** Stops the running turn of a session. */
  async interrupt(sessionId: string): Promise<void> {
    const record = this.requireRecord(sessionId);
    const live = this.live.get(sessionId);
    if (!live?.run || record.status !== 'running') {
      throw new ConflictException('The session is not running');
    }
    live.interruptRequested = true;
    await live.run.interrupt();
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
        mapper: new SdkEventMapper(),
        tracker: new UsageTracker(),
        log: new SessionLog(),
        historyLoaded: null,
        subscribers: 0,
        anchor: { uuid: null, userId: null },
        context: null,
        interruptRequested: false,
        closing: null,
        idleTimer: null,
      };
      this.live.set(id, live);
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
            await this.transcripts.read(record.sdkSessionId, record.cwd),
          );
        } catch (error) {
          failed = true;
          this.logger.warn(
            `Could not read the transcript of ${record.id}: ${String(error)}`,
          );
        }
      }
      // Nothing else is logged before the history is loaded.
      for (const item of buildHistory(
        entries,
        this.storedEvents.list(record.id),
      )) {
        live.log.append(item.event, item.at);
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

  private startRun(
    live: LiveSession,
    record: SessionRecord,
    firstMessage: { id: string; text: string },
  ): void {
    this.clearIdleTimer(live);
    live.mapper = new SdkEventMapper();
    live.tracker = new UsageTracker(this.usage.totalsByModel(record.id));
    live.interruptRequested = false;
    live.closing = null;
    live.starting = (async () => {
      try {
        const run = await this.runner.start(
          {
            cwd: record.cwd,
            additionalDirectories: record.additionalDirectories,
            model: record.model,
            permissionMode: record.permissionMode,
            resume: record.sdkSessionId,
            sessionId: record.sdkSessionId ? null : record.id,
            canUseTool: this.canUseTool(live),
          },
          firstMessage,
        );
        live.run = run;
        void this.consume(live, run);
      } catch (error) {
        this.failRun(live, error);
      } finally {
        live.starting = null;
      }
      if (!live.run) {
        this.releaseIfUnused(live);
      }
    })();
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
    if (live.run !== run || this.shuttingDown) {
      return;
    }
    live.run = null;
    this.clearIdleTimer(live);
    live.log.clearDrafts();
    if (failure && !live.closing) {
      this.failRun(live, failure);
    } else {
      this.setStatus(live, 'finished');
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
      return;
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
    const interrupted = live.interruptRequested;
    live.interruptRequested = false;
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
    const queued = (result.queued_turn_count ?? 0) > 0;
    if (!this.setStatus(live, queued ? 'running' : 'waiting')) {
      // Usage changed even if the status did not.
      this.updates.next(this.toDto(this.requireRecord(live.id)));
    }
    const run = live.run;
    if (run) {
      void this.refreshContext(live, run);
      void this.limits.refreshPlanUsage(() => run.planUsage());
    }
  }

  private async refreshContext(
    live: LiveSession,
    run: AgentRun,
  ): Promise<void> {
    try {
      const usage = await run.contextUsage();
      live.context = {
        model: usage.model,
        usedTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        percentage: usage.percentage,
        updatedAt: new Date().toISOString(),
      };
      this.append(live, { type: 'context.usage', context: live.context });
    } catch (error) {
      this.logger.warn(
        `Context usage of ${live.id} unavailable: ${String(error)}`,
      );
    }
  }

  /**
   * Approval dialogs come in a later step. Until then every tool use that
   * needs approval is denied, visibly for the user.
   */
  private canUseTool(live: LiveSession): CanUseTool {
    return async (toolName, input, options) => {
      this.append(live, {
        type: 'permission.denied',
        toolUseId: options.toolUseID,
        toolName,
        input,
        message: NO_APPROVAL_UI_MESSAGE,
        reason: 'no_approval_ui',
      });
      return { behavior: 'deny', message: NO_APPROVAL_UI_MESSAGE };
    };
  }

  private failRun(live: LiveSession, error: unknown): void {
    live.run = null;
    const message = error instanceof Error ? error.message : String(error);
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
    if (record.status !== status) {
      this.append(live, { type: 'session.status', status });
    }
    if (status === 'waiting') {
      this.startIdleTimer(live);
    } else {
      this.clearIdleTimer(live);
    }
    this.updates.next(this.toDto(updated));
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
    this.events.next({ sessionId: live.id, event });
  }

  private appendUserMessage(
    live: LiveSession,
    message: { id: string; text: string },
  ): void {
    this.append(live, { type: 'user.message', ...message });
    // Claude Code uses the message ID as the transcript entry's UUID.
    live.anchor = { uuid: message.id, userId: message.id };
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
      status: record.status,
      cwd: record.cwd,
      additionalDirectories: record.additionalDirectories,
      lastError: record.lastError,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      usage: totals,
      context: this.live.get(record.id)?.context ?? null,
    };
  }
}
