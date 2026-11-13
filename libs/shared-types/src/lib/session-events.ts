import type { AccountLimits } from './limits';
import type {
  GitPushAnalysis,
  PermissionRequestKind,
  PermissionResolutionCause,
  PermissionResponse,
  PullRequestCall,
  SessionAllowOffer,
  UserQuestion,
} from './permissions';
import type {
  ContextUsage,
  SessionDto,
  SessionPermissionMode,
  SessionStatus,
  SessionWaitingFor,
  UsageTotals,
} from './session';

/**
 * WebSocket protocol between the web app and the API (`/api/ws`).
 *
 * All frames are JSON objects with a `type` discriminator. The server sends
 * `hello` with its protocol version first; a client that does not support
 * that version must not continue. New event and message types may be added
 * without a version bump; clients ignore types they do not know. Changing or
 * removing a field of an existing type requires a new version.
 */
export const SESSION_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Session events: what happened in a session. The server keeps them per
// session and replays them to clients that subscribe later.
// ---------------------------------------------------------------------------

interface SessionEventBase {
  /**
   * Position in the session's event log. Increases monotonically within one
   * log; seq numbers of different logs (see `logId` in `session.history`)
   * cannot be compared.
   */
  seq: number;
  /**
   * When the event happened (ISO 8601). `null` for conversation events
   * rebuilt from a Claude Code transcript: the Agent SDK returns transcript
   * messages without timestamps.
   */
  at: string | null;
}

/** A message the user sent. */
export interface UserMessageEvent extends SessionEventBase {
  type: 'user.message';
  /** Client-side ID of the message, when it came from this app. */
  id: string;
  text: string;
}

/**
 * A piece of assistant text while it streams; sent live only, not kept in
 * the log (see `drafts` in `session.history`). Deltas with the same
 * `messageId` and `blockIndex` belong together; the matching
 * `assistant.text` event replaces them.
 */
export interface AssistantDeltaEvent extends SessionEventBase {
  type: 'assistant.delta';
  messageId: string;
  blockIndex: number;
  text: string;
  parentToolUseId: string | null;
}

/** A complete text block of an assistant message. */
export interface AssistantTextEvent extends SessionEventBase {
  type: 'assistant.text';
  messageId: string;
  /** Index of the block whose deltas this replaces; `null` if not streamed. */
  blockIndex: number | null;
  text: string;
  parentToolUseId: string | null;
}

/** Claude calls a tool. */
export interface ToolCallEvent extends SessionEventBase {
  type: 'tool.call';
  messageId: string;
  toolUseId: string;
  name: string;
  input: unknown;
  /** Set when the call happens inside a subagent started by that tool use. */
  parentToolUseId: string | null;
}

/** Result of a tool call. */
export interface ToolResultEvent extends SessionEventBase {
  type: 'tool.result';
  toolUseId: string;
  isError: boolean;
  /** Text content of the result, possibly truncated. */
  content: string;
  truncated: boolean;
  parentToolUseId: string | null;
}

/**
 * Claude needs the user's decision: a tool use that needs approval, a
 * question (`AskUserQuestion`) or a plan (`ExitPlanMode`). It stays pending
 * until a `permission.resolved` with the same `requestId` follows; every
 * client shows it, and the first answer counts (`permission.respond` frame
 * or `POST /api/sessions/:id/permission-requests/:requestId`). Stored, so
 * a reloaded history shows requests and decisions.
 */
export interface PermissionRequestEvent extends SessionEventBase {
  type: 'permission.request';
  /** ID of the request (UUID). */
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  kind: PermissionRequestKind;
  /** Prompt sentence from Claude Code, e.g. "Claude wants to read foo.txt". */
  title: string | null;
  /** Subtitle from Claude Code, e.g. what access it would grant. */
  description: string | null;
  /** Short name of the action, e.g. "Read file". */
  displayName: string | null;
  /** Why Claude Code asks, e.g. the rule that requires asking. */
  decisionReason: string | null;
  /** Path outside the allowed directories that triggered the request. */
  blockedPath: string | null;
  /** Set when a subagent asks. */
  agentId: string | null;
  /** For Bash commands with `git push`: what each push would update. */
  gitPushes: GitPushAnalysis[];
  /** For `create_pull_request`: the pull request it would create. */
  pullRequest: PullRequestCall | null;
  /**
   * What "Allow for this session" would allow; `null` when only "allow
   * once" is offered (always for pushes, pull requests, questions, plans).
   */
  sessionAllow: SessionAllowOffer | null;
  /** For `question`: the questions. */
  questions: UserQuestion[] | null;
  /** For `plan`: the plan (Markdown). */
  plan: string | null;
}

/** A `permission.request` was answered or cancelled. */
export interface PermissionResolvedEvent extends SessionEventBase {
  type: 'permission.resolved';
  requestId: string;
  toolUseId: string;
  /** `deny` also for cancelled requests (the tool was not used). */
  decision: 'allow' | 'deny';
  /** For allowed tool uses: once, or the session-wide allow was applied. */
  scope: 'once' | 'session' | null;
  cause: PermissionResolutionCause;
  /** The user's message to Claude with a denial (or plan feedback). */
  message: string | null;
  /** For questions: the answers given. */
  answers: Record<string, string> | null;
  /** For plans, or a session-wide allow that switched modes: the new mode. */
  mode: SessionPermissionMode | null;
  /** For `scope: 'session'`: what was allowed for the rest of the session. */
  sessionAllow: SessionAllowOffer | null;
}

/**
 * A message the user sent while Claude was working; it waits in the
 * app's queue and goes to Claude when the current turn ends (see
 * `message.dequeued`). Stored.
 */
export interface MessageQueuedEvent extends SessionEventBase {
  type: 'message.queued';
  /** Client-side ID of the message; the later `user.message` keeps it. */
  id: string;
  text: string;
}

/**
 * A queued message left the queue:
 * - `sent`: it went to Claude (a `user.message` with the same ID follows);
 * - `removed`: the user removed it;
 * - `withdrawn`: it was not sent because the turn was stopped, the
 *   session ended or failed, or the server stopped (`reason` says which).
 */
export interface MessageDequeuedEvent extends SessionEventBase {
  type: 'message.dequeued';
  id: string;
  outcome: 'sent' | 'removed' | 'withdrawn';
  reason: string | null;
}

/**
 * The model or permission mode of the session changed: by the user, by
 * approving a plan, or by Claude Code itself (e.g. entering plan mode).
 * Stored.
 */
export interface SettingsChangedEvent extends SessionEventBase {
  type: 'settings.changed';
  /** New model when it changed (`null`: Claude Code's default). */
  model?: string | null;
  permissionMode?: SessionPermissionMode;
  cause: 'user' | 'plan' | 'claude';
}

/** A tool use was denied without asking the user. */
export interface PermissionDeniedEvent extends SessionEventBase {
  type: 'permission.denied';
  toolUseId: string;
  toolName: string;
  input: unknown;
  /** Why it was denied; also what Claude was told. */
  message: string;
  /**
   * `rule`: by Claude Code (a rule or the permission mode); `user` and
   * `no_approval_ui` appear only in histories from before the approval
   * dialogs (denials by the user are `permission.resolved` now).
   */
  reason: 'no_approval_ui' | 'rule' | 'user';
}

/** The status of the session changed. */
export interface StatusEvent extends SessionEventBase {
  type: 'session.status';
  status: SessionStatus;
  /** What a `waiting` session waits for (absent from older servers). */
  waitingFor?: SessionWaitingFor | null;
}

/** A turn ended (one per user message, or per interruption). */
export interface TurnResultEvent extends SessionEventBase {
  type: 'turn.result';
  /** `success` or the SDK's error subtype, e.g. `error_max_turns`. */
  subtype: string;
  isError: boolean;
  interrupted: boolean;
  durationMs: number;
  /** Model round trips of the turn. */
  numTurns: number;
  /** Usage of this turn, all models together. */
  usage: UsageTotals;
  errors: string[];
}

/** Context window usage after a turn. */
export interface ContextUsageEvent extends SessionEventBase {
  type: 'context.usage';
  context: ContextUsage;
}

/** Informational or warning message, e.g. an API retry or compaction. */
export interface NoticeEvent extends SessionEventBase {
  type: 'notice';
  level: 'info' | 'warning';
  text: string;
}

/** An error in the session (failed start, crashed process, API error). */
export interface ErrorEvent extends SessionEventBase {
  type: 'error';
  message: string;
}

/**
 * A step of preparing the session's directories (status `preparing`):
 * - `fetch`: update the repository's shared clone (clone it on first use);
 * - `clone`: create the session's clone of the mirror and its branch;
 * - `scratch`: create the session's scratch directory;
 * - `rollback`: remove the session's directories again after a failure;
 * - `done`: preparation finished, the first message goes to Claude (not
 *   sent if a setup script failed; a warning `notice` says so instead).
 */
export interface PrepareProgressEvent extends SessionEventBase {
  type: 'prepare.progress';
  step: 'fetch' | 'clone' | 'scratch' | 'rollback' | 'done';
  state: 'started' | 'succeeded' | 'failed';
  /** `owner/name` of the repository. */
  target: string | null;
  /** Directory concerned, e.g. the new clone. */
  path: string | null;
  /** Detail such as the base commit or the error. */
  message: string | null;
}

/**
 * Output (stdout and stderr interleaved) of a repository's setup script,
 * in chunks as it runs. Stored output is capped; see `setup.result`.
 */
export interface SetupOutputEvent extends SessionEventBase {
  type: 'setup.output';
  /** `owner/name` of the repository. */
  repository: string;
  text: string;
}

/** A setup script started or ended. */
export interface SetupResultEvent extends SessionEventBase {
  type: 'setup.result';
  repository: string;
  /** Session clone the script ran in. */
  path: string;
  state: 'started' | 'succeeded' | 'failed' | 'timed_out' | 'skipped';
  exitCode: number | null;
  /** Signal that ended the script, e.g. after the timeout. */
  signal: string | null;
  durationMs: number | null;
  /** Error when the script could not run at all. */
  message: string | null;
  /**
   * Set when the output exceeded the limit and later `setup.output` chunks
   * were dropped: the last lines of the output.
   */
  outputTail: string | null;
}

export type SessionEvent =
  | UserMessageEvent
  | AssistantDeltaEvent
  | AssistantTextEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | PermissionResolvedEvent
  | PermissionDeniedEvent
  | MessageQueuedEvent
  | MessageDequeuedEvent
  | SettingsChangedEvent
  | StatusEvent
  | TurnResultEvent
  | ContextUsageEvent
  | NoticeEvent
  | ErrorEvent
  | PrepareProgressEvent
  | SetupOutputEvent
  | SetupResultEvent;

export type SessionEventType = SessionEvent['type'];

/** A session event without the fields the event log assigns. */
export type SessionEventInput = WithoutLogFields<SessionEvent>;
type WithoutLogFields<E> = E extends unknown ? Omit<E, 'seq' | 'at'> : never;

// ---------------------------------------------------------------------------
// Server -> client frames
// ---------------------------------------------------------------------------

export interface HelloMessage {
  type: 'hello';
  protocolVersion: number;
}

/** Text of an assistant block that is still streaming. */
export interface AssistantDraft {
  messageId: string;
  blockIndex: number;
  /** All text streamed so far; replaces what the client has for the block. */
  text: string;
  parentToolUseId: string | null;
}

/**
 * Answer to `subscribe`. Live events follow as `session.event`.
 *
 * - `complete: true`: `events` is the whole log; replace what the client
 *   knew about the session.
 * - `complete: false`: the client's `after` position is still valid;
 *   `events` holds only the newer events.
 *
 * Streamed text deltas are not part of the log; `drafts` carries the text of
 * blocks still streaming.
 */
export interface SessionHistoryMessage {
  type: 'session.history';
  session: SessionDto;
  /**
   * Identifies the event log. It changes when the server rebuilds the log
   * (after a restart or after releasing an unused session); seq numbers are
   * only comparable within one log.
   */
  logId: string;
  complete: boolean;
  events: SessionEvent[];
  drafts: AssistantDraft[];
}

/** A live event of a subscribed session. */
export interface SessionEventMessage {
  type: 'session.event';
  sessionId: string;
  event: SessionEvent;
}

/** A session was created or changed. Sent to all clients. */
export interface SessionUpdatedMessage {
  type: 'session.updated';
  session: SessionDto;
}

/** The account-wide rate limits changed. Sent to all clients. */
export interface AccountLimitsMessage {
  type: 'account.limits';
  limits: AccountLimits;
}

/** A client frame was rejected. */
export interface ErrorMessage {
  type: 'error';
  /** `requestId` of the client frame, when it had one. */
  requestId: string | null;
  message: string;
}

/** A client frame with a `requestId` was accepted. */
export interface AckMessage {
  type: 'ack';
  requestId: string;
}

export type ServerMessage =
  | HelloMessage
  | SessionHistoryMessage
  | SessionEventMessage
  | SessionUpdatedMessage
  | AccountLimitsMessage
  | ErrorMessage
  | AckMessage;

// ---------------------------------------------------------------------------
// Client -> server frames. `requestId` is optional; when set, the server
// answers with `ack` or `error` carrying it.
// ---------------------------------------------------------------------------

/** Position in an event log a client has seen up to. */
export interface LogPosition {
  logId: string;
  seq: number;
}

/**
 * Receive the history and live events of a session. With `after`, only
 * events newer than that position are sent if the log still exists.
 */
export interface SubscribeMessage {
  type: 'subscribe';
  sessionId: string;
  after?: LogPosition;
  requestId?: string;
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  sessionId: string;
  requestId?: string;
}

/**
 * Send a user message. Starts a turn, is queued behind the running turn
 * (`message.queued`), or resumes a finished session.
 */
export interface SendMessageMessage {
  type: 'message.send';
  sessionId: string;
  /** Client-generated ID (UUID), echoed in `user.message`. */
  id: string;
  text: string;
  requestId?: string;
}

/** Stop the running turn. */
export interface InterruptMessage {
  type: 'interrupt';
  sessionId: string;
  requestId?: string;
}

/**
 * End the session: stops its Claude Code process and marks it finished. A
 * later message resumes it.
 */
export interface EndSessionMessage {
  type: 'session.end';
  sessionId: string;
  requestId?: string;
}

/**
 * Answer a `permission.request` (see {@link PermissionResponse} for the
 * fields per kind). Answering a request that is resolved already is
 * acknowledged without effect; the `permission.resolved` event says how it
 * was decided.
 */
export interface PermissionResponseMessage extends PermissionResponse {
  type: 'permission.respond';
  sessionId: string;
  requestId: string;
  permissionRequestId: string;
}

/** Remove a queued message before it goes to Claude. */
export interface UnqueueMessage {
  type: 'message.unqueue';
  sessionId: string;
  /** ID of the queued message. */
  messageId: string;
  requestId?: string;
}

/** Change the model or permission mode (see `UpdateSessionRequest`). */
export interface UpdateSessionMessage {
  type: 'session.update';
  sessionId: string;
  model?: string | null;
  permissionMode?: SessionPermissionMode;
  requestId?: string;
}

/**
 * Send the pending first message (`SessionDto.pendingMessage`) although a
 * setup script failed.
 */
export interface SendPendingMessage {
  type: 'pending.send';
  sessionId: string;
  requestId?: string;
}

/**
 * Run the failed setup scripts again; on success the pending first message
 * goes to Claude.
 */
export interface RerunSetupMessage {
  type: 'setup.rerun';
  sessionId: string;
  requestId?: string;
}

export type ClientMessage =
  | SubscribeMessage
  | UnsubscribeMessage
  | SendMessageMessage
  | InterruptMessage
  | EndSessionMessage
  | SendPendingMessage
  | RerunSetupMessage
  | PermissionResponseMessage
  | UnqueueMessage
  | UpdateSessionMessage;

// ---------------------------------------------------------------------------
// REST payloads about approval requests
// ---------------------------------------------------------------------------

/** Response of `GET /api/sessions/:id/permission-requests`: pending ones. */
export interface PendingPermissionRequestsResponse {
  requests: PermissionRequestEvent[];
}

/**
 * Response of `POST /api/sessions/:id/permission-requests/:requestId`:
 * how the request was resolved. `alreadyResolved` is set when it had been
 * answered (or cancelled) before; the answer sent was ignored then.
 */
export interface PermissionResponseResult {
  resolved: PermissionResolvedEvent;
  alreadyResolved: boolean;
}
