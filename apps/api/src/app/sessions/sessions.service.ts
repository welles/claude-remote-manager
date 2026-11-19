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
  CLAUDE_WAIT_LIMIT_MINUTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  SESSION_PERMISSION_MODES,
  summarizePendingRequests,
  type AttachmentDto,
  type ContextUsage,
  type CreateSessionRequest,
  type FileDiff,
  type LogPosition,
  type MessageContextResponse,
  type MessageReference,
  type MessageReferenceRequest,
  type PendingRequestSummary,
  type PermissionModeOverride,
  type PermissionRequestEvent,
  type PermissionResponseResult,
  type PullRequestCall,
  type RepositoryAddedBy,
  type SessionDto,
  type SessionEvent,
  type SessionDirectoryDto,
  type SessionEventInput,
  type SessionListFilter,
  type SessionPermissionMode,
  type SessionStatus,
  type SessionWaitingFor,
  type UpdateSessionRequest,
} from '@claude-remote-manager/shared-types';
import {
  AgentRunner,
  type AgentRun,
  type AgentGateDecision,
  type AgentToolCall,
  type AgentUserMessage,
} from '../agent/agent-runner';
import { AttachmentStore } from '../attachments/attachment.store';
import {
  formatUntrustedContext,
  untrustedTag,
  type UntrustedContext,
} from '../agent/untrusted-context';
import {
  GitHubReferencesService,
  parseReferenceRequests,
} from '../github-references/github-references.service';
import {
  MessageContextRepository,
  type MessageContextSummary,
} from './message-context.repository';
import {
  ToolApprover,
  type PermissionResolvedInput,
} from '../agent/tool-approval';
import {
  ADD_REPOSITORY_TOOL,
  ADD_REPOSITORY_TOOL_NAME,
  APP_MCP_SERVER,
  APP_TOOLS_WITHOUT_APPROVAL,
  CREATE_PULL_REQUEST_TOOL_NAME,
  READ_ONLY_TOOLS,
  SET_SESSION_TITLE_TOOL,
  SET_SESSION_TITLE_TOOL_NAME,
  SET_WAITING_STATE_TOOL,
  SET_WAITING_STATE_TOOL_NAME,
} from './app-tools';
import type { AgentTool } from '../agent/agent-runner';
import { zeroTurnMessages } from '../agent/sdk-agent-runner';
import {
  AdditionRefused,
  RepositoryAdditions,
  type ResolvedAddition,
} from '../workspaces/repository-additions';
import { sessionAllows, unresolvedRequests } from './permission-requests';
import { SlashCommandsService } from './slash-commands.service';
import { PreviewsService } from '../previews/previews.service';
import {
  SessionAutomationHooks,
  type AutofixCommandOutcome,
} from './session-automation-hooks';
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
  type AdditionOutcome,
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
  isActiveDirectory,
  SessionRepository,
  workingDirectory,
  type SessionDirectoryRecord,
  type SessionRecord,
} from './session.repository';
import { EMPTY_USAGE, UsageRepository } from './usage.repository';
import { sumUsage, UsageTracker } from './usage-tracker';

const MAX_MESSAGE_LENGTH = 100_000;
const MAX_TITLE_LENGTH = 200;
/** Titles Claude sets are short: the user recognizes the session by them. */
const MAX_CLAUDE_TITLE_LENGTH = 80;
const MAX_WAITING_REASON_LENGTH = 60;
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
  /** GitHub references of the message (`[]` without). */
  references: MessageReference[];
  /** Length of the untrusted context sent with it, if any. */
  contextLength: number | null;
  origin: 'user' | 'app';
}

/**
 * A message for a session (see {@link SessionsService.sendMessage}): the
 * user's from the input, or one the app composes (the PR automation).
 */
export interface SessionMessageInput {
  /** UUID; also the message's UUID in the transcript. New if absent. */
  id?: string;
  /**
   * The words of the message, delivered to Claude Code as typed: `@path`
   * mentions are expanded, a leading `/command` runs. Text of origin `app`
   * may contain neither (put variable content into `untrusted`).
   */
  text: string;
  /** `app`: composed by the app, not typed by the user. Default `user`. */
  origin?: 'user' | 'app';
  /** Uploaded images (`POST /api/attachments`). */
  attachmentIds?: string[];
  /**
   * GitHub issues and pull requests to fetch through the GitHub App and
   * give Claude as untrusted context.
   */
  references?: MessageReferenceRequest[];
  /**
   * Further untrusted content the caller fetched itself (e.g. review
   * comments, CI logs), given to Claude like the references: wrapped, as
   * data, never expanded or run.
   */
  untrusted?: UntrustedContext;
  /**
   * The turn this message starts runs in `default` where the session uses
   * `auto` or `bypassPermissions` (an Autofix run, which works on untrusted
   * GitHub content): nothing runs without the user's approval until that
   * turn ends.
   */
  holdAutoMode?: boolean;
}

/** What a message's references and untrusted content became. */
interface PreparedContext {
  references: MessageReference[];
  /** The text Claude gets before the message; `null` without. */
  text: string | null;
}

/** A queued message, ready for Claude Code (images loaded). */
interface QueuedMessage extends UserMessage {
  agent: AgentUserMessage;
}

/**
 * Modes in which tool calls run without the user (a classifier or nothing
 * decides): an Autofix run, which works on untrusted GitHub content, runs
 * in `default` instead until its turn ends.
 */
export function heldForUntrusted(mode: SessionPermissionMode): boolean {
  return mode === 'auto' || mode === 'bypassPermissions';
}

/** Shown in the approval dialog for the calls of an Autofix run. */
export const AUTOFIX_ASK_REASON =
  'Autofix run on GitHub content: every action but reading is confirmed, whatever allow rules say';

/**
 * Whether a call asks to run in the background (Claude Code also accepts
 * the string).
 */
function runsInBackground(call: AgentToolCall): boolean {
  const background = call.input['run_in_background'];
  return background === true || background === 'true';
}

/**
 * Tools whose work goes on after their call (subagents, which may run in
 * the background whatever the call says; monitors, schedules, workflows,
 * teammates): refused during an Autofix run.
 */
const LATER_WORK_TOOLS: ReadonlySet<string> = new Set([
  'Agent',
  'Task',
  'Monitor',
  'CronCreate',
  'ScheduleWakeup',
  'Workflow',
  'RemoteTrigger',
  'TeamCreate',
  'SendMessage',
]);

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
  /**
   * Set when a turn ended and the session waits for the user: only then is
   * Claude Code's prompt suggestion for that turn taken (it arrives a few
   * seconds after the result; by then another message may have been sent).
   */
  suggestionOpen: boolean;
  context: ContextUsage | null;
  /** When the context usage was last requested during a turn. */
  contextRequestedAt: number;
  /**
   * Set when the running turn is being stopped: by the user (Stop; queued
   * messages are withdrawn), by a denial without message (the queue goes
   * on) or to send queued messages right away (`send`, see `sendNow`).
   */
  interruptRequested: 'user' | 'denied' | 'send' | null;
  /**
   * Queued messages the user sent right away, by ID (`all`: the whole
   * queue): they go to Claude when the stopped turn ends, the others stay
   * queued.
   */
  sendNow: Set<string> | 'all' | null;
  /**
   * Messages sent while a turn runs; they go to Claude when it ends. Held
   * by the app (not Claude Code's own queue) so that they can be removed.
   */
  queue: QueuedMessage[];
  /** IDs of messages whose sending has begun (images being loaded). */
  sending: Set<string>;
  /** Settles when the message sent before has been queued or sent. */
  order: Promise<void>;
  /**
   * Context messages sent to the current process whose own result has not
   * arrived yet: Claude Code answers each message with `shouldQuery:
   * false` with a result of zero turns, which is not the end of a turn.
   */
  contextResults: number;
  /** Status and `waitingFor` last published (`status/waitingFor`). */
  publishedStatus: string;
  /** The pending requests' summary last published (JSON). */
  publishedPending: string;
  /** Why the current process is being closed on purpose. */
  closing: 'idle' | 'shutdown' | 'end' | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Settles when the message loop of the current process has ended. */
  consuming: Promise<void> | null;
  /** Stops the preparation of a repository being added (ending the session). */
  addition: AbortController | null;
  /**
   * `add_repository` calls the user approved, by tool use ID: what the
   * user saw and allowed, used once by the tool (calls that did not ask
   * are resolved by the tool itself).
   */
  additionGrants: Map<string, ResolvedAddition>;
  /**
   * Set when an added repository could not be given to the running process
   * (a Claude Code that cannot add directories): the process is restarted
   * when the turn ends, and continued with this app message if set.
   */
  reopen: { continueWith: string | null } | null;
  /**
   * Set from sending a message with `holdAutoMode` until the end of the
   * turn it started (`delivered`: it reached Claude Code): a session in
   * `auto` or `bypassPermissions` runs in `default` meanwhile.
   */
  autoHold: { messageId: string; delivered: boolean } | null;
  /**
   * Tasks (subagents, background commands) started during an Autofix run
   * and not settled yet: stopped when the run ends, so nothing it started
   * goes on unheld.
   */
  heldTasks: Set<string>;
  /**
   * Background tasks of the current process that still run, by task ID
   * (`background_tasks_changed`, without ambient ones such as watchers):
   * while there are any, a session whose turn is over waits for them
   * (`waitingFor: 'background'`) and its process is not closed for
   * idleness. Empty without process.
   */
  backgroundTasks: Set<string>;
  /**
   * Runs after the last background task ended while the session waits:
   * Claude Code usually takes the task's report as a turn of its own, which
   * shows only with its first answer. Until then (or the timeout) the
   * session still waits for background work, so it does not look ready (and
   * report "finished") in between.
   */
  backgroundGrace: ReturnType<typeof setTimeout> | null;
  /**
   * Runs from the end of a turn: once it fired (`backgroundOverdue`), the
   * background tasks alone no longer make the session wait for them (a
   * task that never ends, such as a dev server, would hold it forever).
   */
  backgroundLimit: ReturnType<typeof setTimeout> | null;
  backgroundOverdue: boolean;
  /**
   * What Claude said the session waits for after the current or last turn
   * (`set_waiting_state`): ahead of the background tasks; cleared when the
   * next turn starts, with the process, and `work` after
   * `claudeWaitLimitMs` (`timer`).
   */
  claudeWait: {
    on: 'user' | 'work';
    reason: string | null;
    timer: ReturnType<typeof setTimeout> | null;
  } | null;
  /**
   * The mode the current process last reported (`init`/`status`), or that
   * it accepted; `null` without process.
   */
  reportedMode: PermissionMode | null;
  /** Mode switches of the app in flight (`setPermissionMode`). */
  modeRequests: number;
  /** The permission mode override last published (JSON). */
  publishedOverride: string;
}

/** How long shutdown waits for Claude Code processes to exit. */
export const SHUTDOWN_GRACE_MS = 5000;

/** Notice stored when a server stop interrupts a running turn. */
export const RESTART_NOTICE =
  'The response was interrupted because the server stopped. Send a message to continue.';

/** Error of a session whose preparation a server stop cut off. */
export const PREPARATION_INTERRUPTED =
  'The preparation was interrupted because the server stopped; its directories were removed again. Start a new session.';

/**
 * Notice when the process ends while background tasks of Claude run or
 * Claude said it goes on by itself.
 */
export const BACKGROUND_TASKS_ENDED =
  'Claude Code ended, and with it the background work it was still doing or waiting for.';

/**
 * How long a session still waits for background work after the last task
 * ended, for the turn Claude Code starts with its report.
 */
export const BACKGROUND_REPORT_GRACE_MS = 30_000;

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
  private readonly deletions = new Subject<string>();
  private shuttingDown = false;
  /** See {@link BACKGROUND_REPORT_GRACE_MS}; tests shorten it. */
  backgroundReportGraceMs = BACKGROUND_REPORT_GRACE_MS;
  /** See `CLAUDE_WAIT_LIMIT_MINUTES`; tests shorten it. */
  claudeWaitLimitMs = CLAUDE_WAIT_LIMIT_MINUTES * 60_000;
  /**
   * Called when a session's history was built (the search index rebuilds
   * the session's entries from it); `transcript` is whether the
   * transcript could be read.
   */
  historyLoaded:
    | ((
        sessionId: string,
        events: readonly SessionEventInput[],
        transcript: boolean,
      ) => void)
    | null = null;
  /** Called for every event added to a session's log (the search index). */
  eventAppended:
    | ((sessionId: string, event: SessionEventInput) => void)
    | null = null;

  /** Events of all sessions, as they are added to the session logs. */
  readonly events$ = this.events.asObservable();
  /** Sessions after any change of their metadata, status or usage. */
  readonly updates$ = this.updates.asObservable();
  /** IDs of sessions deleted for good. */
  readonly deletions$ = this.deletions.asObservable();

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
    @Optional()
    private readonly githubReferences?: GitHubReferencesService,
    @Optional()
    private readonly contexts?: MessageContextRepository,
    @Optional()
    private readonly automation?: SessionAutomationHooks,
    @Optional()
    private readonly previews?: PreviewsService,
    // Checks Claude's `add_repository` calls; without it sessions do not
    // get the tool.
    @Optional()
    private readonly additions?: RepositoryAdditions,
    // Keeps what each session's Claude Code reports for `/` autocomplete.
    @Optional()
    private readonly slashCommands?: SlashCommandsService,
  ) {}

  /**
   * Sessions still marked running were cut off by a server stop that did not
   * shut down cleanly; they wait for the user again. Preparations that were
   * cut off are rolled back and their sessions marked failed.
   */
  async onModuleInit(): Promise<void> {
    await this.workspaces.rollbackInterruptedAdditions((sessionId, event) =>
      this.storedEvents.add(sessionId, event, { uuid: null, userId: null }),
    );
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
    // Before anything starts (no session's git races it; failures only log).
    await this.support.cleanUpClones(this.sessions.list());
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

  /** Sessions, newest first; without archived ones unless asked. */
  list(archived: SessionListFilter = 'exclude'): SessionDto[] {
    const records = this.sessions.list(archived);
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
    const referenceRequests = parseReferenceRequests(body['references']);
    const chosenTitle = optionalString(body, 'title', {
      maxLength: MAX_TITLE_LENGTH,
    })?.trim();
    const title =
      chosenTitle ||
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
    // Resolved now, so the chips show at once; sent with the message later.
    const context = await this.prepareContext(referenceRequests);
    let record: SessionRecord;
    try {
      record = this.sessions.create({
        id: randomUUID(),
        title,
        // A title the user chose is never replaced by Claude's.
        titleSource: chosenTitle ? 'user' : 'prompt',
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
    this.saveContext(record.id, message.id, 'user', context);
    const live = this.liveSession(record.id);
    live.historyLoaded = Promise.resolve();
    this.append(live, {
      type: 'session.status',
      status: 'preparing',
      waitingFor: null,
    });
    this.appendUserMessage(live, {
      ...message,
      attachments,
      references: context.references,
      contextLength: context.text?.length ?? null,
      origin: 'user',
    });
    const dto = this.toDto(record);
    this.updates.next(dto);
    this.startPreparation(live, message);
    return dto;
  }

  /**
   * Sends a user message (REST, WebSocket). Starts a turn, queues it behind
   * the running turn (it goes to Claude when the turn ends), or resumes the
   * session if no process is running.
   */
  async send(
    sessionId: string,
    message: {
      id?: string;
      text: string;
      attachmentIds?: string[];
      references?: MessageReferenceRequest[];
    },
  ): Promise<void> {
    const body = requireObject(message);
    const { text, attachmentIds } = this.messageContent(body, 'text');
    await this.sendMessage(sessionId, {
      // The ID goes to Claude Code as the message UUID.
      id: optionalUuid(body, 'id'),
      text,
      attachmentIds,
      references: parseReferenceRequests(body['references']),
      origin: 'user',
    });
    // The owner answered: automerge waits no longer for their decision.
    this.automation?.ownerMessage?.(sessionId);
  }

  /**
   * Sends a message to a session, with untrusted context if it has any:
   * the reusable way to give Claude content that nobody in this session
   * wrote (GitHub issues, review comments, CI output). The context goes to
   * Claude Code right before the message, wrapped and marked as untrusted
   * data that does not come from the user, and delivered as written (never
   * `@` expanded or run as a slash command; see `sdkUserMessages`); the
   * message's own text is delivered as typed. GitHub references are
   * resolved first; references that cannot be resolved do not stop the
   * message (Claude is told their content is missing). Stored with the
   * message, so the history shows its references and what Claude got.
   * Like {@link send}, it starts a turn, queues the message or resumes the
   * session.
   */
  async sendMessage(
    sessionId: string,
    input: SessionMessageInput,
  ): Promise<void> {
    const origin = input.origin ?? 'user';
    const text = input.text;
    if (origin === 'app' && (text.includes('@') || /^\s*\//.test(text))) {
      throw new Error(
        'Text the app composes must contain no @ and not start with /: put such content into the untrusted context',
      );
    }
    const attachmentIds = input.attachmentIds ?? [];
    const id = input.id ?? randomUUID();
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
    const previous = live.order;
    let release = () => undefined as void;
    live.order = new Promise<void>((resolve) => (release = resolve));
    try {
      // Marked until it is queued or sent: a second request with this ID
      // that arrives during the awaits below finds it here.
      live.sending.add(id);
      let attachments: AttachmentDto[];
      let context: PreparedContext;
      let agent: AgentUserMessage;
      try {
        attachments = this.attachmentStore(attachmentIds).claim(
          attachmentIds,
          sessionId,
          id,
        );
        context = await this.prepareContext(
          input.references ?? [],
          input.untrusted,
        );
        this.saveContext(sessionId, id, origin, context);
        agent = await this.agentMessage(sessionId, { id, text });
        // Messages are queued or sent in the order they arrived, even when
        // an earlier one takes longer to prepare (its references).
        await previous;
        if (live.starting) {
          await live.starting;
        }
        if (live.closing && live.consuming) {
          // The process is being closed (ended, idle, restarted for an
          // added repository): the message goes to the next one.
          await live.consuming;
        }
        if (input.holdAutoMode) {
          await this.holdAutoMode(live, id);
        }
      } finally {
        live.sending.delete(id);
      }
      // No await from here on until it is queued or sent.
      if (this.isKnownMessage(live, id)) {
        return;
      }
      const message: UserMessage = {
        id,
        text,
        attachments,
        references: context.references,
        contextLength: context.text?.length ?? null,
        origin,
      };
      if (live.run && this.requireRecord(sessionId).status === 'running') {
        live.queue.push({ ...message, agent });
        this.append(live, {
          type: 'message.queued',
          id,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(message.references.length > 0
            ? { references: message.references }
            : {}),
        });
        return;
      }
      this.appendUserMessage(live, message);
      this.markDelivered(live, id);
      if (live.run) {
        const delivered = this.withNote(live, agent);
        live.run.send(delivered);
        this.countContext(live, delivered);
        this.setStatus(live, 'running');
      } else {
        this.setStatus(live, 'running');
        this.startRun(live, this.requireRecord(sessionId), { id, text });
      }
    } finally {
      // Not sent, not queued (a duplicate, or an error): no turn to hold.
      if (!live.queue.some((queued) => queued.id === id)) {
        this.dropHeld(live, id);
      }
      release();
    }
  }

  /**
   * The context the app gave Claude with a message (GitHub content),
   * exactly as Claude got it; 404 when the message had none.
   */
  messageContext(sessionId: string, messageId: string): MessageContextResponse {
    this.requireRecord(sessionId);
    const record = this.contexts?.get(sessionId, messageId);
    if (!record?.context) {
      throw new NotFoundException(
        `Message ${messageId} of session ${sessionId} has no context`,
      );
    }
    return {
      messageId,
      context: record.context,
      references: record.references,
    };
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
    this.dropHeld(live, messageId);
    this.append(live, {
      type: 'message.dequeued',
      id: messageId,
      outcome: 'removed',
      reason: null,
    });
  }

  /**
   * Sends queued messages to Claude right away: stops the running turn (as
   * Stop does, but the queue is kept) and sends the message `messageId`, or
   * all queued messages, when it ended. A single message moves to the
   * front; the others stay queued for the end of the next turn. Fails with
   * 409 when the message (or no message) is queued.
   */
  async sendQueuedNow(
    sessionId: string,
    messageId: string | null,
  ): Promise<void> {
    this.requireRecord(sessionId);
    const live = this.live.get(sessionId);
    if (live?.starting) {
      await live.starting;
    }
    const index = messageId
      ? (live?.queue.findIndex((queued) => queued.id === messageId) ?? -1)
      : (live?.queue.length ?? 0) - 1;
    if (!live?.run || index < 0) {
      throw new ConflictException(
        messageId
          ? 'The message is not queued: it was sent to Claude already or withdrawn'
          : 'No message is queued',
      );
    }
    const run = live.run;
    if (this.requireRecord(sessionId).status !== 'running') {
      if (live.closing || live.reopen) {
        throw new ConflictException(
          'Claude Code is being restarted: the queued messages are sent after its next turn',
        );
      }
      // No turn to stop: they go to Claude now.
      const only = messageId ? new Set([messageId]) : null;
      if (this.flushQueue(live, run, only) > 0) {
        this.setStatus(live, 'running');
      }
      return;
    }
    if (messageId) {
      const [message] = live.queue.splice(index, 1);
      live.queue.unshift(message);
      if (live.sendNow !== 'all') {
        live.sendNow = new Set(live.sendNow).add(messageId);
      }
    } else {
      live.sendNow = 'all';
    }
    if (live.interruptRequested) {
      // Being stopped already: the turn's end sends them.
      return;
    }
    live.interruptRequested = 'send';
    this.approver.cancelSession(sessionId, 'interrupted');
    await run.interrupt();
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
    let title: string | undefined;
    if ('title' in body) {
      title = optionalString(body, 'title', {
        maxLength: MAX_TITLE_LENGTH,
      })?.trim();
      if (!title) {
        throw new BadRequestException('title must not be blank');
      }
    }
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
    if (title !== undefined && title !== record.title) {
      // Only the title: slug, branches and directories keep their names.
      // From now on Claude does not change it any more.
      this.changeTitle(sessionId, title, 'user');
    } else if (title !== undefined && record.titleSource !== 'user') {
      // Confirmed as it is: still the user's choice from now on.
      this.sessions.update(sessionId, { titleSource: 'user' });
    }
    if (Object.keys(changes).length === 0) {
      return this.get(sessionId);
    }
    const live = this.live.get(sessionId);
    if (live?.starting) {
      await live.starting;
    }
    const run = live?.run;
    if (run && live) {
      try {
        if (changes.permissionMode) {
          await this.requestMode(
            live,
            run,
            this.processMode(live, changes.permissionMode),
          );
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
      // Claude Code leaves `auto` for a model without auto mode and does
      // not return by itself: ask again (fails for such a model).
      if (
        this.processMode(live, this.requireRecord(sessionId).permissionMode) ===
          'auto' &&
        live.reportedMode !== 'auto'
      ) {
        void this.requestMode(live, run, 'auto').catch(() => undefined);
      }
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
    live?.addition?.abort();
    if (live) {
      live.reopen = null;
    }
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
    // Its dev servers end with it (previews and the processes behind them).
    try {
      await this.previews?.stopSession(sessionId);
    } catch (error) {
      this.logger.warn(
        `Stopping the dev servers of ${sessionId} failed: ${String(error)}`,
      );
    }
    return this.get(sessionId);
  }

  /**
   * Adds a registered repository to the session (the user's control in
   * the session details): its clone on the session branch is made and its
   * setup script runs in the background, shown in the history like the
   * session's own preparation. Once ready, a running Claude Code process
   * gets it as a working directory right away (also during a turn); Claude
   * is told its path, branch and base branch with the next message.
   */
  async addRepository(
    sessionId: string,
    request: unknown,
  ): Promise<SessionDto> {
    const body = requireObject(request);
    const repositoryId = body['repositoryId'];
    if (typeof repositoryId !== 'string') {
      throw new BadRequestException('repositoryId must be a UUID');
    }
    const baseBranch =
      optionalString(body, 'baseBranch', { maxLength: 200 })?.trim() || null;
    const live = await this.addableSession(sessionId);
    const directory = this.workspaces.planAddition(
      sessionId,
      repositoryId,
      baseBranch,
      'user',
    );
    void this.runAddition(live, directory, 'user').catch((error: unknown) =>
      this.logger.error(
        `Adding ${directory.repositoryName} to ${sessionId} failed: ${errorMessage(error)}`,
      ),
    );
    return this.get(sessionId);
  }

  /**
   * Prepares a repository whose addition failed (cloned again) or is held
   * after a failed setup script (the script runs again).
   */
  async retryAddition(
    sessionId: string,
    repositoryId: string,
  ): Promise<SessionDto> {
    const live = await this.addableSession(sessionId, repositoryId);
    const directory = this.workspaces.beginRetry(
      sessionId,
      this.addedDirectory(sessionId, repositoryId).position,
    );
    void this.runAddition(
      live,
      directory,
      directory.addition?.by ?? 'user',
    ).catch((error: unknown) =>
      this.logger.error(
        `Retrying ${directory.repositoryName} in ${sessionId} failed: ${errorMessage(error)}`,
      ),
    );
    return this.get(sessionId);
  }

  /**
   * Gives Claude an added repository although its setup script failed
   * (like "Send anyway" for a session's first message).
   */
  async acceptAddition(
    sessionId: string,
    repositoryId: string,
  ): Promise<SessionDto> {
    const live = await this.addableSession(sessionId, repositoryId);
    const directory = this.workspaces.acceptHeldAddition(
      sessionId,
      this.addedDirectory(sessionId, repositoryId).position,
    );
    await this.activateAddition(live, directory, 'user');
    this.append(live, {
      type: 'prepare.progress',
      step: 'add',
      state: 'succeeded',
      target: directory.repositoryName,
      path: directory.path,
      message: `Used without a successful setup script · ${additionDetail(directory)}`,
      addition: randomUUID(),
    });
    return this.publish(sessionId);
  }

  /**
   * Removes a repository whose addition failed or is held: its clone and
   * its place in the session. Repositories Claude works in stay.
   */
  async removeAddition(
    sessionId: string,
    repositoryId: string,
  ): Promise<SessionDto> {
    const live = await this.addableSession(sessionId, repositoryId);
    const directory = this.addedDirectory(sessionId, repositoryId);
    await this.workspaces.removeAddition(sessionId, directory.position);
    this.append(live, {
      type: 'notice',
      level: 'info',
      text: `${directory.repositoryName ?? 'The repository'} was removed from the session again.`,
    });
    return this.publish(sessionId);
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

  /**
   * Why the session's directories cannot be cleaned up, nor the session
   * archived or deleted, right now: it is being prepared, a turn runs (also
   * while it waits for an approval) or a process is starting. `null` when
   * nothing stands in the way.
   */
  busyReason(sessionId: string): string | null {
    const record = this.requireRecord(sessionId);
    if (record.status === 'preparing') {
      return 'The session is still being prepared';
    }
    if (record.status === 'running') {
      return 'Claude is working on a turn; stop it first';
    }
    if (this.live.get(sessionId)?.starting) {
      return 'The session is starting; try again in a moment';
    }
    if (this.live.get(sessionId)?.addition) {
      return 'A repository is being added to the session; wait until it is ready';
    }
    return null;
  }

  /** Sets or clears the archived mark and publishes the session. */
  setArchived(sessionId: string, archivedAt: Date | null): SessionDto {
    const updated = this.toDto(this.sessions.update(sessionId, { archivedAt }));
    this.updates.next(updated);
    return updated;
  }

  /**
   * Forgets a session that is being deleted: its in-memory state goes and
   * all clients are told. Call after the database rows are gone.
   */
  forget(sessionId: string): void {
    this.slashCommands?.forget(sessionId);
    const live = this.live.get(sessionId);
    if (live) {
      this.clearIdleTimer(live);
      this.clearBackgroundGrace(live);
      this.clearBackgroundLimit(live);
      this.clearClaudeWait(live);
      const run = live.run;
      // Detached first: the message loop then ends without looking for
      // the session's record.
      live.run = null;
      live.closing = 'end';
      if (run) {
        this.approver.cancelSession(sessionId, 'ended');
        this.support.released(sessionId);
        run.close();
      }
      this.live.delete(sessionId);
    }
    this.deletions.next(sessionId);
  }

  /**
   * The history of a session as the session view shows it, rebuilt from
   * the transcript and the stored events (for the search index), without
   * keeping it in memory. `transcript` says whether the transcript could
   * be read.
   */
  async historyEvents(
    sessionId: string,
  ): Promise<{ events: SessionEventInput[]; transcript: boolean }> {
    const record = this.requireRecord(sessionId);
    const live = this.live.get(sessionId);
    if (live?.historyLoaded) {
      await live.historyLoaded;
      return { events: [...live.log.events], transcript: true };
    }
    const scratch = this.newLiveSession(sessionId);
    const transcript = await this.loadHistory(scratch, record);
    return { events: [...scratch.log.events], transcript };
  }

  /** Number of sessions held in memory (for tests and diagnostics). */
  get liveCount(): number {
    return this.live.size;
  }

  // -------------------------------------------------------------------------

  private liveSession(id: string): LiveSession {
    let live = this.live.get(id);
    if (!live) {
      live = this.newLiveSession(id);
      this.live.set(id, live);
      const record = this.sessions.get(id);
      if (record) {
        live.publishedStatus = statusKey(this.effectiveStatus(record));
      }
    }
    return live;
  }

  private newLiveSession(id: string): LiveSession {
    return {
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
      suggestionOpen: false,
      context: null,
      contextRequestedAt: 0,
      interruptRequested: null,
      sendNow: null,
      queue: [],
      sending: new Set(),
      order: Promise.resolve(),
      contextResults: 0,
      publishedStatus: '',
      publishedPending: 'null',
      closing: null,
      idleTimer: null,
      consuming: null,
      addition: null,
      additionGrants: new Map(),
      reopen: null,
      autoHold: null,
      heldTasks: new Set(),
      backgroundTasks: new Set(),
      backgroundGrace: null,
      backgroundLimit: null,
      backgroundOverdue: false,
      claudeWait: null,
      reportedMode: null,
      modeRequests: 0,
      publishedOverride: 'null',
    };
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
      const transcript = await this.loadHistory(live, record);
      this.historyLoaded?.(record.id, live.log.events, transcript);
    })();
    return live.historyLoaded;
  }

  /**
   * Builds the log of a session from its transcript and stored events.
   * Returns whether the transcript could be read (or there is none yet).
   */
  private async loadHistory(
    live: LiveSession,
    record: SessionRecord,
  ): Promise<boolean> {
    {
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
      const contexts = this.contexts?.forSession(record.id) ?? new Map();
      const extras = (event: SessionEventInput) =>
        withContext(withAttachments(event, images), contexts);
      // Context messages sent before user messages are not conversation.
      const contextIds = new Set(
        [...contexts.values()].map((summary) => summary.contextId),
      );
      entries = entries.filter((entry) => !contextIds.has(entry.uuid));
      if (record.pendingMessage) {
        // Not sent to Claude (yet), so not in the transcript.
        live.log.append(
          extras({ type: 'user.message', ...record.pendingMessage }),
          record.createdAt.toISOString(),
        );
      }
      const history = withInputDiffs(
        buildHistory(entries, this.storedEvents.list(record.id)),
        (event, at) => ({ event, at }),
      );
      for (const item of history) {
        live.log.append(extras(item.event), item.at);
      }
      if (failed) {
        // Live-only: the transcript may be readable next time.
        const notice: SessionEventInput = {
          type: 'notice',
          level: 'warning',
          text: 'The earlier conversation could not be loaded.',
        };
        if (this.live.get(live.id) === live) {
          this.append(live, notice, { store: false });
        } else {
          live.log.append(notice);
        }
      }
      const lastUser = entries.findLast((entry) => entry.isUserMessage);
      live.anchor = {
        uuid: entries.at(-1)?.uuid ?? null,
        userId: lastUser?.uuid ?? null,
      };
      live.context = live.log.findLast('context.usage')?.context ?? null;
      return !failed;
    }
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
    live.sendNow = null;
    live.closing = null;
    live.contextResults = 0;
    live.reportedMode = null;
    try {
      const extras = await this.support.prepare(record);
      // What the user allowed for the session applies to every process.
      const allowed = sessionAllows(this.storedEvents.list(record.id));
      const directories = additionalDirectories(record);
      const first = this.withNote(
        live,
        await this.agentMessage(live.id, firstMessage),
      );
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
          permissionMode: this.processMode(live, record.permissionMode),
          ...(await this.resumeTarget(record)),
          canUseTool: this.canUseTool(live),
          gate: (call) => this.autofixGate(live, call),
          allowedTools: [
            ...allowed.rules,
            ...(extras.allowedTools ?? []),
            // Changes only the title, never one the user chose.
            SET_SESSION_TITLE_TOOL_NAME,
            // Changes only what the session list shows.
            SET_WAITING_STATE_TOOL_NAME,
          ],
          env: { ...SESSION_ENV, ...extras.env },
          tools: [
            ...extras.tools,
            // A title the user chose stays: no tool to change it.
            ...(record.titleSource === 'user' ? [] : [this.setTitleTool(live)]),
            this.setWaitingStateTool(live),
            ...(this.additions ? [this.addRepositoryTool(live)] : []),
          ],
          settings: extras.settings,
          ...(extras.instructions ? { instructions: extras.instructions } : {}),
        },
        first,
      );
      live.run = run;
      this.countContext(live, first);
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
    // A held turn is over with its process.
    live.autoHold = null;
    live.heldTasks.clear();
    const hadBackgroundTasks =
      live.backgroundTasks.size > 0 || live.claudeWait?.on === 'work';
    live.backgroundTasks.clear();
    this.clearBackgroundGrace(live);
    this.clearBackgroundLimit(live);
    this.clearClaudeWait(live);
    live.reportedMode = null;
    this.clearIdleTimer(live);
    live.log.clearDrafts();
    const status = this.requireRecord(live.id).status;
    if (hadBackgroundTasks && status === 'waiting') {
      this.append(live, {
        type: 'notice',
        level: 'warning',
        text: BACKGROUND_TASKS_ENDED,
      });
    }
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
    if (status === 'waiting') {
      // Background tasks end with the process.
      this.publishStatus(live);
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

  /**
   * Asks the process for its slash commands and skills (the project's
   * included) once it is initialized; a failure leaves the last list.
   */
  private loadSlashCommands(live: LiveSession, terminal: string[]): void {
    const commands = this.slashCommands;
    const run = live.run;
    if (!commands || !run) {
      return;
    }
    commands.terminalCommands(terminal);
    run
      .supportedCommands()
      .then((list) => {
        if (live.run === run) {
          commands.remember(live.id, list);
        }
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `Listing the slash commands of ${live.id} failed: ${errorMessage(error)}`,
        ),
      );
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
      this.loadSlashCommands(live, message.terminal_slash_commands ?? []);
      return;
    }
    if (message.type === 'system' && message.subtype === 'commands_changed') {
      this.slashCommands?.remember(live.id, message.commands);
      return;
    }
    if (message.type === 'system' && message.subtype === 'task_started') {
      if (live.autoHold?.delivered) {
        live.heldTasks.add(message.task_id);
      }
    }
    if (message.type === 'system' && message.subtype === 'task_notification') {
      live.heldTasks.delete(message.task_id);
    }
    if (
      message.type === 'system' &&
      message.subtype === 'background_tasks_changed'
    ) {
      this.backgroundTasksChanged(
        live,
        message.tasks
          .filter((task) => !task.ambient)
          .map((task) => task.task_id),
      );
      return;
    }
    if (
      (message.type === 'assistant' || message.type === 'stream_event') &&
      message.parent_tool_use_id === null &&
      !(message.type === 'assistant' && message.agent_id)
    ) {
      this.turnStartedByClaude(live);
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
    if (message.type === 'prompt_suggestion') {
      const open =
        live.suggestionOpen && this.requireRecord(live.id).status === 'waiting';
      live.suggestionOpen = false;
      if (!open) {
        return;
      }
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

  /** Expects the zero-turn result Claude Code sends for a context message. */
  private countContext(live: LiveSession, message: AgentUserMessage): void {
    live.contextResults += zeroTurnMessages(message);
  }

  private handleResult(
    live: LiveSession,
    result: Extract<SDKMessage, { type: 'result' }>,
  ): void {
    if (
      live.contextResults > 0 &&
      result.subtype === 'success' &&
      result.num_turns === 0
    ) {
      // The answer to a context message (`shouldQuery: false`): no turn
      // ended, the message after it starts the turn.
      live.contextResults--;
      return;
    }
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
    const sendNow = live.sendNow;
    live.sendNow = null;
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
    if (
      live.autoHold?.delivered &&
      !live.reopen &&
      (result.queued_turn_count ?? 0) === 0
    ) {
      // The held turn (Autofix run) is over: back to `auto`. With a reopen
      // pending, the hold goes on with the new process (reopenAfterTurn).
      this.releaseAutoHold(live);
    }
    if (live.reopen && (result.queued_turn_count ?? 0) === 0) {
      // An added repository needs a new process: it continues there, with
      // the first queued message (one sent right away is at the front;
      // with all sent right away, the others wait for that turn's end).
      this.setStatus(live, 'waiting');
      this.reopenAfterTurn(live);
      return;
    }
    const run = live.run;
    // Queued messages go to Claude now (Claude Code may take them as one
    // turn). Stop withdrew the queue: what is queued now was sent after
    // it. Sent right away: only those, the others wait for this turn's end.
    const flushed = run ? this.flushQueue(live, run, sendNow) : 0;
    const queued = flushed > 0 || (result.queued_turn_count ?? 0) > 0;
    if (queued || interrupted || result.is_error) {
      // What Claude said comes after this turn does not: another turn
      // follows, or the turn did not end as Claude planned.
      this.clearClaudeWait(live);
    }
    if (!this.setStatus(live, queued ? 'running' : 'waiting')) {
      // Usage changed even if the status did not.
      this.updates.next(this.toDto(this.requireRecord(live.id)));
    }
    live.suggestionOpen = !queued && !interrupted;
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

  /**
   * Sends the queued messages to Claude (`only`: those of them, unless none
   * is queued anymore); returns how many.
   */
  private flushQueue(
    live: LiveSession,
    run: AgentRun,
    only: Set<string> | 'all' | null = null,
  ): number {
    const selected =
      only instanceof Set ? live.queue.filter(({ id }) => only.has(id)) : [];
    const messages =
      selected.length > 0
        ? selected
        : // Nothing selected is queued anymore (removed meanwhile): the
          // queue must not stay behind without a running turn.
          live.queue.splice(0);
    if (selected.length > 0) {
      live.queue = live.queue.filter((queued) => !selected.includes(queued));
    }
    for (const message of messages) {
      this.append(live, {
        type: 'message.dequeued',
        id: message.id,
        outcome: 'sent',
        reason: null,
      });
      this.appendUserMessage(live, message);
      this.markDelivered(live, message.id);
      const delivered = this.withNote(live, message.agent);
      run.send(delivered);
      this.countContext(live, delivered);
    }
    return messages.length;
  }

  /** Drops the queued messages; the user sees them as not sent. */
  private withdrawQueue(live: LiveSession, reason: string): void {
    for (const message of live.queue.splice(0)) {
      this.dropHeld(live, message.id);
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

  /**
   * Records a mode Claude Code reports, if it is one this app uses. While
   * the session is in `auto` or `bypassPermissions`, `default` is not a
   * change of the chosen mode: Claude Code could not use that mode (plan,
   * model, settings), or the app holds it for an Autofix run; the override
   * shows it.
   */
  private syncPermissionMode(live: LiveSession, mode: PermissionMode): void {
    live.reportedMode = mode;
    const record = this.requireRecord(live.id);
    if (!SESSION_PERMISSION_MODES.includes(mode as SessionPermissionMode)) {
      this.logger.warn(
        `Claude Code of ${live.id} reports permission mode ${mode}, which this app does not use`,
      );
      return;
    }
    if (
      mode === record.permissionMode ||
      (heldForUntrusted(record.permissionMode) && mode === 'default')
    ) {
      this.publishOverride(live);
      return;
    }
    this.applySettings(
      live.id,
      { permissionMode: mode as SessionPermissionMode },
      'claude',
    );
  }

  /**
   * The mode the session's process should run in: the chosen one, except
   * `default` for `auto` and `bypassPermissions` while a turn is held
   * (Autofix run).
   */
  private processMode(
    live: LiveSession,
    mode: SessionPermissionMode,
  ): SessionPermissionMode {
    return heldForUntrusted(mode) && live.autoHold ? 'default' : mode;
  }

  /** Switches the running process's mode; rejects if Claude Code refuses. */
  private async requestMode(
    live: LiveSession,
    run: AgentRun,
    mode: SessionPermissionMode,
  ): Promise<void> {
    live.modeRequests++;
    try {
      await run.setPermissionMode(mode);
      if (live.run === run) {
        live.reportedMode = mode;
      }
    } finally {
      live.modeRequests--;
      this.publishOverride(live);
    }
  }

  /**
   * Holds `auto` or `bypassPermissions` for the turn of message `id` (an
   * Autofix run): the process switches to `default` before the message
   * reaches it, or starts in it. Throws (and releases the hold) if Claude
   * Code refuses.
   */
  private async holdAutoMode(live: LiveSession, id: string): Promise<void> {
    live.autoHold = { messageId: id, delivered: false };
    const run = live.run;
    if (run && heldForUntrusted(this.requireRecord(live.id).permissionMode)) {
      try {
        await this.requestMode(live, run, 'default');
      } catch (error) {
        live.autoHold = null;
        this.publishOverride(live);
        throw new Error(
          `Claude Code did not leave ${this.requireRecord(live.id).permissionMode} mode for the run: ${errorMessage(error)}`,
        );
      }
    }
    this.publishOverride(live);
  }

  /** The held message `id` goes to Claude Code now. */
  private markDelivered(live: LiveSession, id: string): void {
    if (live.autoHold?.messageId === id) {
      live.autoHold.delivered = true;
    }
  }

  /**
   * The held message `id` will never reach Claude Code (withdrawn,
   * removed from the queue, not sent): its hold ends, the process returns
   * to the chosen mode.
   */
  private dropHeld(live: LiveSession, id: string): void {
    if (live.autoHold?.messageId === id && !live.autoHold.delivered) {
      this.releaseAutoHold(live);
    }
  }

  /** The held turn ended: the process returns to the chosen mode. */
  private releaseAutoHold(live: LiveSession): void {
    live.autoHold = null;
    const run = live.run;
    // What the run started and is still going (a command moved to the
    // background at its timeout, a subagent) stops with it.
    const tasks = [...live.heldTasks];
    live.heldTasks.clear();
    for (const taskId of tasks) {
      void run?.stopTask(taskId).catch((error: unknown) =>
        this.logger.warn(
          `Could not stop task ${taskId} of ${live.id} after the Autofix run: ${errorMessage(error)}`,
        ),
      );
    }
    const mode = this.requireRecord(live.id).permissionMode;
    if (run && heldForUntrusted(mode)) {
      void this.requestMode(live, run, mode).catch((error: unknown) =>
        this.logger.warn(
          `Claude Code of ${live.id} did not return to ${mode} mode: ${errorMessage(error)}`,
        ),
      );
    }
    this.publishOverride(live);
  }

  /**
   * The mode the process runs in instead of the chosen `auto` or
   * `bypassPermissions`, if any.
   */
  private permissionModeOverride(
    record: SessionRecord,
  ): PermissionModeOverride | null {
    const live = this.live.get(record.id);
    if (!heldForUntrusted(record.permissionMode) || !live) {
      return null;
    }
    if (live.autoHold) {
      return { mode: 'default', reason: 'autofix' };
    }
    if (
      live.run &&
      live.modeRequests === 0 &&
      live.reportedMode === 'default'
    ) {
      return {
        mode: 'default',
        reason:
          record.permissionMode === 'auto'
            ? 'auto_unavailable'
            : 'bypass_unavailable',
      };
    }
    return null;
  }

  /** Publishes the session if its permission mode override changed. */
  private publishOverride(live: LiveSession): void {
    const record = this.sessions.get(live.id);
    if (!record) {
      return;
    }
    const key = JSON.stringify(this.permissionModeOverride(record));
    if (key !== live.publishedOverride) {
      live.publishedOverride = key;
      this.updates.next(this.toDto(record));
    }
  }

  /**
   * Sets the title (a rename by the user, or Claude's tool), logs it and
   * publishes the session.
   */
  private changeTitle(
    sessionId: string,
    title: string,
    cause: 'user' | 'claude',
  ): void {
    const updated = this.sessions.update(sessionId, {
      title,
      titleSource: cause,
    });
    this.recordEvent(sessionId, { type: 'settings.changed', title, cause });
    this.updates.next(this.toDto(updated));
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
   * meanwhile. Calls the permission mode or an allow rule lets through
   * never get here.
   */
  /**
   * During an Autofix run (its turn, `autoHold` delivered) every tool call
   * but reading goes to the user (`canUseTool`, with Autofix's own git add,
   * commit and push), whatever allow rules of the user, the project or
   * "Allow for this session" say: the run works on untrusted GitHub
   * content, which could make Claude push elsewhere with the user's
   * credentials. Background work is refused: it would go on after the run
   * (unheld) and start a turn of its own with what it found. Outside a run
   * Claude Code decides (`null`).
   */
  private autofixGate(
    live: LiveSession,
    call: AgentToolCall,
  ): AgentGateDecision | null {
    if (!live.autoHold?.delivered || READ_ONLY_TOOLS.has(call.toolName)) {
      return null;
    }
    if (LATER_WORK_TOOLS.has(call.toolName)) {
      return {
        decision: 'deny',
        reason: `${call.toolName} is not available during an Autofix run: what it starts would go on after the run.`,
      };
    }
    if (this.requireRecord(live.id).permissionMode === 'dontAsk') {
      // The session's mode asks nobody: refused, as Claude Code would.
      return {
        decision: 'deny',
        reason: 'Not pre-approved, and this session does not ask (dontAsk).',
      };
    }
    if (runsInBackground(call)) {
      return {
        decision: 'deny',
        reason:
          'Not during an Autofix run: background work would go on after the run. Run it in the foreground.',
      };
    }
    return { decision: 'ask', reason: AUTOFIX_ASK_REASON };
  }

  private canUseTool(live: LiveSession): CanUseTool {
    return async (toolName, input, options) => {
      if (
        APP_TOOLS_WITHOUT_APPROVAL.has(toolName) &&
        (!options.mcpServer ||
          (options.mcpServer.name === APP_MCP_SERVER &&
            options.mcpServer.source === 'sdk'))
      ) {
        // Showing a file reads only inside the session's directories;
        // previews forward only the session user's ports: never asks.
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
      if (command && this.automation?.autofixCommand) {
        // During autofix the app runs add, commit and push itself.
        let outcome: AutofixCommandOutcome | null = null;
        try {
          outcome = await this.automation.autofixCommand(
            live.id,
            command,
            gitPushes,
          );
        } catch (error) {
          this.logger.warn(
            `Autofix git command of ${live.id} failed: ${errorMessage(error)}`,
          );
        }
        if (outcome) {
          this.append(live, {
            type: 'tool.by_app',
            toolUseId: options.toolUseID,
            outcome: outcome.ok ? 'succeeded' : 'failed',
            summary: outcome.summary,
          });
          // The shell only prints what the app did (and fails if it did).
          return {
            behavior: 'allow',
            updatedInput: {
              ...input,
              command: reportCommand(outcome.output, outcome.ok),
            },
          };
        }
      }
      let addition: ResolvedAddition | null = null;
      if (
        toolName === ADD_REPOSITORY_TOOL_NAME &&
        (mcpServer === null ||
          (mcpServer.name === APP_MCP_SERVER && mcpServer.source === 'sdk'))
      ) {
        if (!this.additions) {
          return {
            behavior: 'deny',
            message: 'Repositories cannot be added on this server.',
          };
        }
        try {
          addition = await this.additions.resolve(
            this.requireRecord(live.id),
            input,
          );
        } catch (error) {
          if (error instanceof AdditionRefused) {
            // Nothing the user could allow: Claude is told why at once.
            return {
              behavior: 'deny',
              message: `add_repository was refused (the user was not asked): ${error.message}`,
            };
          }
          throw error;
        }
      }
      const decision = await this.approver.decide({
        sessionId: live.id,
        toolName,
        input,
        gitPushes,
        repositoryAddition: addition?.call ?? null,
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
        // During an Autofix run every call asks anyway (`autofixGate`).
        suppressAlwaysAllow:
          options.suppressAlwaysAllowRule === true ||
          live.autoHold?.delivered === true,
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
      if (addition) {
        // Exactly what the user saw, used once by the tool.
        live.additionGrants.set(options.toolUseID, addition);
      }
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

  // --- Adding repositories ------------------------------------------------

  /**
   * The session, in memory, if a repository may be added (or an addition
   * retried, accepted or removed) now: not while it is prepared, archived,
   * without its directories, holding back its first message, or while
   * another repository is being added.
   */
  private async addableSession(
    sessionId: string,
    repositoryId?: string,
  ): Promise<LiveSession> {
    const record = this.requireRecord(sessionId);
    if (repositoryId === undefined || record.status === 'preparing') {
      this.requireUsable(record);
    } else if (record.archivedAt) {
      throw new ConflictException(
        'The session is archived; unarchive it to continue',
      );
    }
    const live = this.liveSession(sessionId);
    await this.ensureHistory(live, record);
    if (live.addition) {
      throw new ConflictException(
        'A repository is being added to this session; wait until it is ready',
      );
    }
    return live;
  }

  /** The added directory of a repository of the session (404 otherwise). */
  private addedDirectory(
    sessionId: string,
    repositoryId: string,
  ): SessionDirectoryRecord {
    const directory = this.requireRecord(sessionId).directories.find(
      (entry) => entry.repositoryId === repositoryId && entry.addition,
    );
    if (!directory) {
      throw new NotFoundException(
        `Repository ${repositoryId} was not added to session ${sessionId}`,
      );
    }
    return directory;
  }

  /** Publishes the session and returns it. */
  private publish(sessionId: string): SessionDto {
    const dto = this.get(sessionId);
    this.updates.next(dto);
    return dto;
  }

  /**
   * Prepares an added repository (see `SessionWorkspaceService`) and, once
   * ready, gives it to Claude. The history shows it as one row like the
   * session's own preparation: `prepare.progress` with step `add` around
   * the fetch, clone and setup steps, all with the same `addition` ID.
   */
  private async runAddition(
    live: LiveSession,
    directory: SessionDirectoryRecord,
    by: RepositoryAddedBy,
  ): Promise<AdditionOutcome> {
    const controller = new AbortController();
    live.addition = controller;
    const addition = randomUUID();
    const name = directory.repositoryName ?? 'the repository';
    const emit = (event: SessionEventInput) =>
      this.append(
        live,
        event.type === 'prepare.progress' ? { ...event, addition } : event,
      );
    this.publish(live.id);
    try {
      emit({
        type: 'prepare.progress',
        step: 'add',
        state: 'started',
        target: directory.repositoryName,
        path: directory.path,
        message: by === 'claude' ? 'Requested by Claude' : 'Added by you',
      });
      let outcome: AdditionOutcome;
      try {
        outcome = await this.workspaces.prepareAddition(
          live.id,
          directory.position,
          addition,
          (event) => this.append(live, event),
          controller.signal,
        );
      } catch (error) {
        // Not expected: the workspace reports failures as outcomes.
        outcome = { state: 'failed', error: errorMessage(error), directory };
      }
      if (outcome.state === 'ready') {
        await this.activateAddition(live, outcome.directory, by);
        emit({
          type: 'prepare.progress',
          step: 'add',
          state: 'succeeded',
          target: directory.repositoryName,
          path: directory.path,
          message: additionDetail(outcome.directory),
        });
      } else {
        emit({
          type: 'prepare.progress',
          step: 'add',
          state: 'failed',
          target: directory.repositoryName,
          path: directory.path,
          message:
            outcome.state === 'held'
              ? `${outcome.error}: ${name} is not given to Claude yet. Run the setup again, use it anyway, or remove it in the session details.`
              : `Could not add ${name}: ${outcome.error}. Retry or remove it in the session details.`,
        });
      }
      return outcome;
    } finally {
      live.addition = null;
      this.publish(live.id);
      if (!live.run && !live.starting) {
        this.releaseIfUnused(live);
      }
    }
  }

  /**
   * Gives Claude a repository that is ready: a running process gets it as
   * a working directory right away (Claude Code announces it to Claude with
   * its next request); otherwise the next process starts with it. The user's
   * additions are announced with the next message (path, branch, base);
   * Claude's own learn it from the tool's result. If the running Claude
   * Code cannot add directories, the process is restarted: at once when no
   * turn runs, else when the turn ends.
   */
  private async activateAddition(
    live: LiveSession,
    directory: SessionDirectoryRecord,
    by: RepositoryAddedBy,
  ): Promise<void> {
    if (by === 'user') {
      this.sessions.updateDirectory(live.id, directory.position, {
        announce: true,
      });
    }
    const run = live.run;
    if (!run) {
      return;
    }
    try {
      await run.addDirectories([directory.path]);
    } catch (error) {
      this.logger.warn(
        `Claude Code of ${live.id} could not add ${directory.path}; restarting it: ${errorMessage(error)}`,
      );
      if (this.requireRecord(live.id).status === 'running') {
        live.reopen ??= { continueWith: null };
      } else {
        this.closeForRestart(live);
      }
    }
  }

  /**
   * Closes the session's process without a status change; the next
   * message starts a new one (resumed, with the current directories).
   */
  private closeForRestart(live: LiveSession): void {
    const run = live.run;
    if (!run) {
      return;
    }
    this.clearIdleTimer(live);
    live.closing = 'idle';
    run.close();
  }

  /**
   * When a turn ends with a restart pending (see {@link activateAddition}):
   * closes the process and continues the session in a new one, with the
   * app's message (Claude's addition) or the first queued message. Returns
   * whether it did.
   */
  private reopenAfterTurn(live: LiveSession): boolean {
    const reopen = live.reopen;
    const run = live.run;
    if (!reopen || !run) {
      return false;
    }
    live.reopen = null;
    // The end of the process ends the hold; it carries over to the new one.
    const hold = live.autoHold;
    this.closeForRestart(live);
    const next = (live.consuming ?? Promise.resolve()).then(async () => {
      if (
        hold &&
        !hold.delivered &&
        live.queue.some((queued) => queued.id === hold.messageId)
      ) {
        // The held message still waits in the queue: still held.
        live.autoHold = hold;
      }
      if (reopen.continueWith) {
        await this.sendMessage(live.id, {
          text: reopen.continueWith,
          origin: 'app',
          // The continuation of a held turn (Autofix run) is held as well.
          holdAutoMode: hold?.delivered === true,
        });
        return;
      }
      const first = live.queue.shift();
      if (first) {
        this.append(live, {
          type: 'message.dequeued',
          id: first.id,
          outcome: 'sent',
          reason: null,
        });
        this.appendUserMessage(live, first);
        this.markDelivered(live, first.id);
        this.setStatus(live, 'running');
        this.startRun(live, this.requireRecord(live.id), first);
      }
    });
    next.catch((error: unknown) =>
      this.logger.error(
        `Continuing ${live.id} after a restart failed: ${errorMessage(error)}`,
      ),
    );
    return true;
  }

  /**
   * The note Claude gets with the next message about repositories the user
   * added (path, branch, base branch), once; `undefined` without.
   */
  private takeNote(sessionId: string): AgentUserMessage['note'] {
    const record = this.requireRecord(sessionId);
    const added = record.directories.filter(
      (directory) =>
        directory.addition?.announce && isActiveDirectory(directory),
    );
    if (added.length === 0) {
      return undefined;
    }
    for (const directory of added) {
      this.sessions.updateDirectory(sessionId, directory.position, {
        announce: false,
      });
    }
    return {
      id: randomUUID(),
      text: [
        'Note from the session manager (not written by the user):',
        ...added.map(
          (directory) =>
            `- The user added the repository ${directory.repositoryName} to this session. ` +
            `Its clone is ${directory.path}, on the session branch ${directory.branch}` +
            `${directory.baseBranch ? `, created from ${directory.baseBranch}` : ''}` +
            `${directory.baseCommit ? ` at ${directory.baseCommit.slice(0, 12)}` : ''}. ` +
            'It is one of your working directories now; work in it like in your other clones.',
        ),
      ].join('\n'),
    };
  }

  /** A message for Claude Code with the pending note, if any. */
  private withNote(
    live: LiveSession,
    message: AgentUserMessage,
  ): AgentUserMessage {
    const note = this.takeNote(live.id);
    return note ? { ...message, note } : message;
  }

  /**
   * The tool `set_session_title`: Claude names the session once it knows
   * what it is about and keeps the name up to date. No approval: it changes
   * only the title, and never one the user chose (given when creating, or a
   * rename).
   */
  private setTitleTool(live: LiveSession): AgentTool {
    return {
      name: SET_SESSION_TITLE_TOOL,
      description:
        'Set the title of this session: the user recognizes the session by it in the list of ' +
        'sessions and in notifications. Set it once you know what the session is about, after ' +
        'reading what the task refers to (an issue, a pull request, files, an error message): ' +
        'name the actual subject, not the request (not "Work on issue #12", but what issue #12 ' +
        'is about). Set it again when the topic of the session changes substantially (another ' +
        'task, or the problem turned out to be a different one), not for each step. Short and ' +
        'distinctive: about 3 to 6 words, no trailing period, no quotes, in the language the ' +
        'user writes in. A title the user chose stays; the result says so.',
      inputSchema: (z) => ({
        title: z
          .string()
          .min(1)
          .max(MAX_CLAUDE_TITLE_LENGTH)
          .describe('The new title, e.g. "Dark mode for the settings page"'),
      }),
      handler: async (input) => {
        const title = String(input['title']).replace(/\s+/g, ' ').trim();
        if (!title) {
          return { isError: true, text: 'The title must not be blank.' };
        }
        const record = this.requireRecord(live.id);
        if (record.titleSource === 'user') {
          return {
            text: `The user chose the title "${record.title ?? ''}" themselves; it stays. Do not set the title in this session again.`,
          };
        }
        if (title !== record.title) {
          this.changeTitle(live.id, title, 'claude');
        }
        return { text: `The session is titled "${title}".` };
      },
    };
  }

  /**
   * The tool `set_waiting_state`: Claude says what the session waits for
   * once the turn is over, ahead of what the background tasks suggest. No
   * approval: it changes only how the session is shown and notified.
   */
  private setWaitingStateTool(live: LiveSession): AgentTool {
    return {
      name: SET_WAITING_STATE_TOOL,
      description:
        'Say what this session waits for once your turn ends, so the user can tell whether they ' +
        'need to act. Only for the main conversation, never from a subagent. Call it near the ' +
        'end of a turn after starting background work, or when you will continue on your ' +
        'own. "user": it ' +
        "is the user's turn (you are done, asked something, or need a decision), also when " +
        'background work you started (such as a dev server) does not have to finish first. ' +
        '"work": you go on by yourself without the user: you wait for background tasks or ' +
        'agents, a scheduled wakeup, a monitor, or CI or a deploy you will check; give a short ' +
        `reason (e.g. "CI of PR #12", at most ${MAX_WAITING_REASON_LENGTH} characters). It holds ` +
        `until the next turn starts, "work" at most ${CLAUDE_WAIT_LIMIT_MINUTES} minutes after ` +
        'the turn; after that an idle process may be closed, so a later wakeup may not fire. ' +
        'Without it, the session manager decides from the background tasks still running.',
      inputSchema: (z) => ({
        waiting_on: z
          .enum(['user', 'work'])
          .describe(
            '"user": the user\'s turn; "work": you continue by yourself',
          ),
        reason: z
          .string()
          .max(MAX_WAITING_REASON_LENGTH)
          .optional()
          .describe(
            'With "work": what you wait for, a few words in the language the user writes in',
          ),
      }),
      handler: async (input) => {
        const on = input['waiting_on'] === 'work' ? 'work' : 'user';
        const reason =
          on === 'work'
            ? String(input['reason'] ?? '')
                .replace(/\s+/g, ' ')
                .trim() || null
            : null;
        if (this.requireRecord(live.id).status !== 'running') {
          return {
            isError: true,
            text: 'Only during a turn of the main conversation: it says what follows the turn.',
          };
        }
        this.clearClaudeWait(live);
        // The time limit starts when the turn ends.
        live.claudeWait = { on, reason, timer: null };
        return {
          text:
            on === 'work'
              ? `After this turn the session shows that you go on by yourself${reason ? ` (${reason})` : ''}, until the next turn starts, for at most ${CLAUDE_WAIT_LIMIT_MINUTES} minutes.`
              : "After this turn the session shows that the user's input is needed.",
        };
      },
    };
  }

  /** Starts the time limit of Claude's `work` once its turn is over. */
  private startClaudeWaitTimer(live: LiveSession): void {
    const wait = live.claudeWait;
    if (wait?.on !== 'work' || wait.timer) {
      return;
    }
    wait.timer = setTimeout(
      () => this.claudeWaitExpired(live),
      this.claudeWaitLimitMs,
    );
    wait.timer.unref?.();
  }

  /** Claude's word that it goes on by itself ran out: back to the tasks. */
  private claudeWaitExpired(live: LiveSession): void {
    if (!live.claudeWait) {
      return;
    }
    live.claudeWait.timer = null;
    this.clearClaudeWait(live);
    if (
      this.live.get(live.id) !== live ||
      this.sessions.get(live.id)?.status !== 'waiting' ||
      live.closing
    ) {
      return;
    }
    if (live.run && !live.idleTimer) {
      this.startIdleTimer(live);
    }
    if (!this.publishStatus(live)) {
      this.updates.next(this.toDto(this.requireRecord(live.id)));
    }
  }

  /**
   * The tool `add_repository`: adds a repository to the session, waits
   * until its clone is ready and tells Claude truthfully what happened. It
   * asks like any tool, as the session's permission mode says; when the
   * user was asked, exactly what they approved is added (see
   * {@link canUseTool}).
   */
  private addRepositoryTool(live: LiveSession): AgentTool {
    return {
      name: ADD_REPOSITORY_TOOL,
      description:
        'Add another repository to this session when the task needs changes (or reading) in a ' +
        'repository that is not one of your directories yet, so that you can continue in this ' +
        'conversation. Name a repository the session manager knows ' +
        '(owner/name: a registered repository, a local project local/PROJECT, or one its GitHub ' +
        'App can access) or give a remote clone URL (https or ssh; no local paths). The repository ' +
        "gets its own clone on the session branch, like the session's other repositories, and its " +
        'setup script runs; this can take a while. The result says where the clone is. Do not use ' +
        'it for repositories you only want to look up on the web.',
      inputSchema: (z) => ({
        repository: z
          .string()
          .max(200)
          .optional()
          .describe(
            'owner/name of the repository (a local project: local/PROJECT); or use url',
          ),
        url: z
          .string()
          .max(500)
          .optional()
          .describe(
            'Remote clone URL (https:// or ssh://, git@host:owner/name.git); or use repository',
          ),
        base_branch: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Branch to start from; default: the repository's default branch",
          ),
        reason: z
          .string()
          .min(1)
          .max(1000)
          .describe(
            'Why the task needs this repository; shown to the user with the request',
          ),
      }),
      handler: async (input, { toolUseId }) => {
        let grant = toolUseId ? live.additionGrants.get(toolUseId) : undefined;
        if (toolUseId) {
          live.additionGrants.delete(toolUseId);
        }
        if (!grant) {
          // Not asked (the permission mode or an allow rule let it run).
          if (!this.additions) {
            return {
              isError: true,
              text: 'Repositories cannot be added on this server.',
            };
          }
          try {
            grant = await this.additions.resolve(
              this.requireRecord(live.id),
              input,
            );
          } catch (error) {
            return {
              isError: true,
              text: `No repository was added: ${httpErrorText(error)}.`,
            };
          }
        }
        const name = grant.call.repository;
        let directory: SessionDirectoryRecord;
        try {
          if (live.addition) {
            throw new ConflictException(
              'another repository is being added to this session right now; try again when it is ready',
            );
          }
          const repositoryId = await this.additions?.register(grant.target);
          if (!repositoryId) {
            throw new Error('repositories cannot be added on this server');
          }
          directory = this.workspaces.planAddition(
            live.id,
            repositoryId,
            grant.baseBranch,
            'claude',
          );
        } catch (error) {
          return {
            isError: true,
            text: `${name} was not added: ${httpErrorText(error)}. It is not available in this session.`,
          };
        }
        const outcome = await this.runAddition(live, directory, 'claude');
        const reopening = outcome.state === 'ready' && live.reopen !== null;
        if (reopening && live.reopen) {
          live.reopen.continueWith = continuationText(outcome.directory);
        }
        return {
          text: additionResult(outcome, name, reopening),
          isError: outcome.state !== 'ready',
        };
      },
    };
  }

  private failRun(live: LiveSession, error: unknown, run?: AgentRun): void {
    live.run = null;
    live.autoHold = null;
    live.heldTasks.clear();
    live.backgroundTasks.clear();
    this.clearBackgroundGrace(live);
    this.clearBackgroundLimit(live);
    this.clearClaudeWait(live);
    live.reportedMode = null;
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
    if (status !== 'waiting') {
      live.suggestionOpen = false;
      // A turn runs: background work reported back or is waited for anew,
      // and Claude says anew what comes after it.
      this.clearBackgroundGrace(live);
      this.clearBackgroundLimit(live);
      this.clearClaudeWait(live);
    }
    if (status === 'waiting') {
      this.startClaudeWaitTimer(live);
      this.startBackgroundLimit(live);
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
  /** What the pending approval requests ask for, while there are any. */
  private pendingSummary(record: SessionRecord): PendingRequestSummary | null {
    return record.status === 'running'
      ? summarizePendingRequests(this.approver.pendingRequests(record.id))
      : null;
  }

  private backgroundTaskCount(sessionId: string): number {
    return this.live.get(sessionId)?.backgroundTasks.size ?? 0;
  }

  /** What Claude said it waits for, while the session shows it. */
  private waitingReason(record: SessionRecord): string | null {
    const wait = this.live.get(record.id)?.claudeWait;
    return wait?.on === 'work' &&
      this.effectiveStatus(record).waitingFor === 'background'
      ? wait.reason
      : null;
  }

  /**
   * Whether a message of the app (such as an autofix run) may start a turn
   * now: the session waits for a message, or only because Claude said it
   * goes on by itself (`set_waiting_state` with `work`, e.g. "CI of PR #12")
   * while no background task of it still runs or is about to report back.
   * Claude may well be waiting for exactly what the app brings.
   */
  acceptsAppMessage(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return false;
    }
    const { status, waitingFor } = this.effectiveStatus(record);
    if (status !== 'waiting') {
      return false;
    }
    if (waitingFor === 'message') {
      return true;
    }
    const live = this.live.get(sessionId);
    return (
      waitingFor === 'background' &&
      live !== undefined &&
      live.claudeWait?.on === 'work' &&
      live.backgroundTasks.size === 0 &&
      live.backgroundGrace === null
    );
  }

  private waitsForBackgroundById(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    return live ? this.waitsForBackground(live) : false;
  }

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
        waitingFor: record.pendingMessage
          ? 'setup'
          : this.waitsForBackgroundById(record.id)
            ? 'background'
            : 'message',
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
    const pending = JSON.stringify(this.pendingSummary(record));
    if (key === live.publishedStatus) {
      if (pending !== live.publishedPending) {
        // Another request came or one was answered: same status, but the
        // session list says what it waits for.
        live.publishedPending = pending;
        this.updates.next(this.toDto(record));
      }
      return false;
    }
    live.publishedStatus = key;
    live.publishedPending = pending;
    this.append(live, { type: 'session.status', ...effective });
    this.updates.next(this.toDto(record));
    return true;
  }

  /**
   * The session's previews changed: while it has active previews its
   * process is not closed for idleness (dev servers Claude started as
   * background tasks end with the process); once the last one stopped,
   * the idle clock starts from now.
   */
  previewsChanged(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (
      !live?.run ||
      this.requireRecord(sessionId).status !== 'waiting' ||
      live.closing
    ) {
      return;
    }
    if (this.keptForPreviews(sessionId)) {
      this.clearIdleTimer(live);
    } else if (!live.idleTimer) {
      this.startIdleTimer(live);
    }
  }

  private keptForPreviews(sessionId: string): boolean {
    return (this.previews?.forSession(sessionId).length ?? 0) > 0;
  }

  /**
   * The process's background tasks changed: a session whose turn is over
   * waits for them (or for the next message once the last one ended), and
   * its process stays while they run (closing it would end them).
   */
  private backgroundTasksChanged(live: LiveSession, taskIds: string[]): void {
    const before = live.backgroundTasks.size;
    live.backgroundTasks = new Set(taskIds);
    const waiting = this.requireRecord(live.id).status === 'waiting';
    if (live.backgroundTasks.size > 0) {
      this.clearBackgroundGrace(live);
    } else if (before > 0 && waiting && !live.closing) {
      this.startBackgroundGrace(live);
    }
    if (!waiting || live.closing) {
      return;
    }
    if (this.keepsProcess(live)) {
      this.clearIdleTimer(live);
    } else if (!live.idleTimer) {
      this.startIdleTimer(live);
    }
    if (!this.publishStatus(live) && before !== live.backgroundTasks.size) {
      // Still waiting for background tasks, but for another number.
      this.updates.next(this.toDto(this.requireRecord(live.id)));
    }
  }

  /** Whether the session goes on by itself after its turn (`background`). */
  private waitsForBackground(live: LiveSession): boolean {
    if (live.claudeWait) {
      return live.claudeWait.on === 'work';
    }
    return (
      !live.backgroundOverdue &&
      (live.backgroundTasks.size > 0 || live.backgroundGrace !== null)
    );
  }

  /** Starts the time limit of waiting for background tasks after a turn. */
  private startBackgroundLimit(live: LiveSession): void {
    this.clearBackgroundLimit(live);
    live.backgroundLimit = setTimeout(() => {
      live.backgroundLimit = null;
      live.backgroundOverdue = true;
      if (
        this.live.get(live.id) !== live ||
        this.sessions.get(live.id)?.status !== 'waiting' ||
        live.closing
      ) {
        return;
      }
      // Ready now (unless Claude said it goes on by itself).
      this.publishStatus(live);
    }, this.claudeWaitLimitMs);
    live.backgroundLimit.unref?.();
  }

  private clearBackgroundLimit(live: LiveSession): void {
    if (live.backgroundLimit) {
      clearTimeout(live.backgroundLimit);
      live.backgroundLimit = null;
    }
    live.backgroundOverdue = false;
  }

  /**
   * Whether the process must stay: its background tasks would end with it,
   * and Claude would not go on by itself.
   */
  private keepsProcess(live: LiveSession): boolean {
    return (
      live.backgroundTasks.size > 0 ||
      live.backgroundGrace !== null ||
      live.claudeWait?.on === 'work'
    );
  }

  private clearClaudeWait(live: LiveSession): void {
    if (live.claudeWait?.timer) {
      clearTimeout(live.claudeWait.timer);
    }
    live.claudeWait = null;
  }

  private startBackgroundGrace(live: LiveSession): void {
    this.clearBackgroundGrace(live);
    if (this.backgroundReportGraceMs <= 0) {
      return;
    }
    live.backgroundGrace = setTimeout(() => {
      live.backgroundGrace = null;
      // No turn of Claude's own followed: the session is ready.
      if (live.run && this.requireRecord(live.id).status === 'waiting') {
        this.startIdleTimer(live);
        if (!this.publishStatus(live) && live.claudeWait?.on === 'work') {
          // Still "background" for Claude's word, but now free for app
          // messages (`acceptsAppMessage`): subscribers such as the PR
          // automation look again.
          this.updates.next(this.toDto(this.requireRecord(live.id)));
        }
      }
    }, this.backgroundReportGraceMs);
    live.backgroundGrace.unref?.();
  }

  private clearBackgroundGrace(live: LiveSession): void {
    if (live.backgroundGrace) {
      clearTimeout(live.backgroundGrace);
      live.backgroundGrace = null;
    }
  }

  /**
   * Claude Code answers while the session waits: it started a turn on its
   * own (a background task reported back), which runs like one the user
   * started and ends with its result.
   */
  private turnStartedByClaude(live: LiveSession): void {
    const record = this.requireRecord(live.id);
    if (
      record.status === 'waiting' &&
      !record.pendingMessage &&
      live.run &&
      !live.closing
    ) {
      this.setStatus(live, 'running');
    }
  }

  private startIdleTimer(live: LiveSession): void {
    this.clearIdleTimer(live);
    if (
      this.config.sessionIdleTimeoutMs <= 0 ||
      this.keptForPreviews(live.id) ||
      this.keepsProcess(live)
    ) {
      return;
    }
    live.idleTimer = setTimeout(() => {
      live.idleTimer = null;
      if (
        live.run &&
        this.requireRecord(live.id).status === 'waiting' &&
        !this.keptForPreviews(live.id) &&
        !this.keepsProcess(live)
      ) {
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
    this.eventAppended?.(live.id, input);
    if (store && STORED_EVENT_TYPES.has(input.type)) {
      this.storedEvents.add(live.id, input, live.anchor);
    }
    if (input.type === 'tool.call') {
      this.support.toolCalled(
        live.id,
        input.name,
        input.input,
        input.toolUseId,
      );
    } else if (input.type === 'tool.result') {
      this.support.toolFinished(live.id, input.toolUseId);
    }
    this.events.next({ sessionId: live.id, event });
  }

  private appendUserMessage(live: LiveSession, message: UserMessage): void {
    // A suggestion still to come belongs to the turn before.
    live.suggestionOpen = false;
    this.append(live, {
      type: 'user.message',
      id: message.id,
      text: message.text,
      ...(message.attachments.length > 0
        ? { attachments: message.attachments }
        : {}),
      ...(message.references.length > 0
        ? { references: message.references }
        : {}),
      ...(message.contextLength !== null
        ? { contextLength: message.contextLength }
        : {}),
      ...(message.origin === 'app' ? { origin: 'app' as const } : {}),
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

  /**
   * A message as Claude Code gets it, with its images and its untrusted
   * context (both stored under the message's ID).
   */
  private async agentMessage(
    sessionId: string,
    message: { id: string; text: string },
  ): Promise<AgentUserMessage> {
    const images =
      (await this.attachments?.agentImages(sessionId, message.id)) ?? [];
    const stored = this.contexts?.get(sessionId, message.id);
    return {
      ...message,
      ...(images.length > 0 ? { images } : {}),
      ...(stored?.context && stored.contextId
        ? { context: { id: stored.contextId, text: stored.context } }
        : {}),
    };
  }

  /**
   * Resolves a message's GitHub references and formats them, with any
   * other untrusted content, into the context Claude gets before it.
   */
  private async prepareContext(
    references: MessageReferenceRequest[],
    untrusted?: UntrustedContext,
  ): Promise<PreparedContext> {
    let resolved: {
      references: MessageReference[];
      context: UntrustedContext | null;
    } = {
      references: [],
      context: null,
    };
    if (references.length > 0) {
      if (!this.githubReferences) {
        throw new BadRequestException('GitHub references are not available');
      }
      resolved = await this.githubReferences.resolve(references);
    }
    const contexts = [resolved.context, untrusted].filter(
      (context): context is UntrustedContext =>
        !!context && context.items.length > 0,
    );
    // One random tag for the whole message.
    const tag = untrustedTag();
    return {
      references: resolved.references,
      text:
        contexts.length > 0
          ? contexts
              .map((context) => formatUntrustedContext(context, tag))
              .join('\n')
          : null,
    };
  }

  /** Stores what goes with a message (references, context, origin). */
  private saveContext(
    sessionId: string,
    messageId: string,
    origin: 'user' | 'app',
    context: PreparedContext,
  ): void {
    if (
      !this.contexts ||
      (context.text === null &&
        context.references.length === 0 &&
        origin === 'user')
    ) {
      return;
    }
    this.contexts.save({
      messageId,
      sessionId,
      origin,
      references: context.references,
      contextId: context.text === null ? null : randomUUID(),
      context: context.text,
    });
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
    if (record.archivedAt) {
      throw new ConflictException(
        'The session is archived; unarchive it to continue',
      );
    }
    if (
      record.directories.some(
        (directory) =>
          isActiveDirectory(directory) && directory.state !== 'ready',
      )
    ) {
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
      permissionModeOverride: this.permissionModeOverride(record),
      ...this.effectiveStatus(record),
      pendingRequests: this.pendingSummary(record),
      backgroundTasks: this.backgroundTaskCount(record.id),
      waitingReason: this.waitingReason(record),
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
          addition: directory.addition
            ? {
                addedAt: directory.addition.addedAt.toISOString(),
                by: directory.addition.by,
                state: directory.addition.state,
                error: directory.addition.error,
              }
            : null,
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
      autoclosedAt: record.autoclosedAt?.toISOString() ?? null,
      previews: this.previews?.forSession(record.id) ?? [],
      archivedAt: record.archivedAt?.toISOString() ?? null,
    };
  }
}

/** Output limit of a command the app carried out itself. */
const REPORT_MAX_LENGTH = 20_000;

/**
 * A shell command that prints `text` exactly (base64, so nothing in it is
 * interpreted) and exits with 1 when `ok` is false: what Claude Code runs
 * for a command the app carried out itself.
 */
export function reportCommand(text: string, ok: boolean): string {
  const bounded =
    text.length > REPORT_MAX_LENGTH
      ? `${text.slice(0, REPORT_MAX_LENGTH)}\n[… cut]`
      : text;
  const encoded = Buffer.from(`${bounded}\n`, 'utf8').toString('base64');
  return `printf '%s' '${encoded}' | base64 -d${ok ? '' : '; false'}`;
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

/**
 * A user message event with its references and context length from the
 * message context store.
 */
function withContext(
  event: SessionEventInput,
  contexts: Map<string, MessageContextSummary>,
): SessionEventInput {
  if (event.type !== 'user.message') {
    return event;
  }
  const summary = contexts.get(event.id);
  if (!summary) {
    return event;
  }
  return {
    ...event,
    ...(summary.references.length > 0
      ? { references: summary.references }
      : {}),
    ...(summary.contextLength !== null
      ? { contextLength: summary.contextLength }
      : {}),
    ...(summary.origin === 'app' ? { origin: 'app' as const } : {}),
  };
}

/** Where an added clone is: its branch, base branch and base commit. */
function additionDetail(directory: SessionDirectoryRecord): string {
  return (
    `${directory.branch ?? 'the session branch'}` +
    `${directory.baseBranch ? ` from ${directory.baseBranch}` : ''}` +
    `${directory.baseCommit ? ` at ${directory.baseCommit.slice(0, 12)}` : ''}` +
    ' · Claude works in it now'
  );
}

/** The message of an error, also of Nest's HTTP exceptions. */
function httpErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[.\s]+$/, '');
}

/** What the tool `add_repository` tells Claude. */
export function additionResult(
  outcome: AdditionOutcome,
  name: string,
  reopening: boolean,
): string {
  if (outcome.state === 'failed') {
    return (
      `${name} was not added: ${outcome.error.replace(/[.\s]+$/, '')}. ` +
      'The repository is not available in this session: do not try to read or change it. ' +
      'Tell the user; they can retry or remove it in the session details.'
    );
  }
  const directory = outcome.directory;
  const where =
    `Its clone is ${directory?.path}, on the session branch ${directory?.branch}` +
    `${directory?.baseBranch ? `, created from ${directory.baseBranch}` : ''}` +
    `${directory?.baseCommit ? ` at ${directory.baseCommit.slice(0, 12)}` : ''}.`;
  if (outcome.state === 'held') {
    return (
      `${name} was cloned, but it is not available to you yet: ${outcome.error.replace(/[.\s]+$/, '')}. ${where} ` +
      'Do not read or change it until you are told it is available. The user can run the setup ' +
      'again, use the repository anyway, or remove it in the session details.'
    );
  }
  if (reopening) {
    return (
      `${name} was added to this session. ${where} This Claude Code process cannot take ` +
      'a new directory while it runs, so the session manager restarts it when this turn ends: ' +
      'end your turn now (say briefly what you will do next). The session manager then continues ' +
      'this conversation with a message saying that the repository is available.'
    );
  }
  return (
    `${name} was added to this session. ${where} It is one of your working directories ` +
    'now: read and change files there as in your other clones, commit on the session branch; ' +
    'pushes and pull requests work as for the other repositories.'
  );
}

/**
 * The app's message that continues the session after a restart for an
 * added repository. App text may contain no `@` (see `sendMessage`).
 */
function continuationText(directory: SessionDirectoryRecord): string {
  const path = directory.path.includes('@') ? null : directory.path;
  return (
    `The repository ${directory.repositoryName} is now available in this session` +
    `${path ? ` at ${path}` : ''}, on the session branch ${directory.branch}` +
    `${directory.baseBranch ? ` (created from ${directory.baseBranch})` : ''}. ` +
    'Continue with the task.'
  );
}
