import type { AccountLimits } from './limits';
import type {
  ContextUsage,
  SessionDto,
  SessionStatus,
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
   * Position in the session's event log of the current server process.
   * Increases monotonically; restarts after a server restart.
   */
  seq: number;
  /** When the event happened (ISO 8601). */
  at: string;
}

/** A message the user sent. */
export interface UserMessageEvent extends SessionEventBase {
  type: 'user.message';
  /** Client-side ID of the message, when it came from this app. */
  id: string;
  text: string;
}

/**
 * A piece of assistant text while it streams. Deltas with the same
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
 * Claude asks for permission to use a tool. Reserved for the approval
 * dialogs (later step); not emitted yet.
 */
export interface PermissionRequestEvent extends SessionEventBase {
  type: 'permission.request';
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  /** Prompt sentence from Claude Code, e.g. "Claude wants to read foo.txt". */
  title: string | null;
  description: string | null;
}

/** A permission request was answered. Reserved like `permission.request`. */
export interface PermissionResolvedEvent extends SessionEventBase {
  type: 'permission.resolved';
  requestId: string;
  decision: 'allow' | 'deny';
}

/** A tool use was denied without asking the user. */
export interface PermissionDeniedEvent extends SessionEventBase {
  type: 'permission.denied';
  toolUseId: string;
  toolName: string;
  input: unknown;
  /** Why it was denied; also what Claude was told. */
  message: string;
  /** `no_approval_ui`: approval dialogs do not exist yet; `rule`: by Claude Code. */
  reason: 'no_approval_ui' | 'rule';
}

/** The status of the session changed. */
export interface StatusEvent extends SessionEventBase {
  type: 'session.status';
  status: SessionStatus;
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

export type SessionEvent =
  | UserMessageEvent
  | AssistantDeltaEvent
  | AssistantTextEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | PermissionResolvedEvent
  | PermissionDeniedEvent
  | StatusEvent
  | TurnResultEvent
  | ContextUsageEvent
  | NoticeEvent
  | ErrorEvent;

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

/**
 * Answer to `subscribe`: the session and its complete event log so far.
 * Replaces whatever the client knew about the session. Live events follow
 * as `session.event`.
 */
export interface SessionHistoryMessage {
  type: 'session.history';
  session: SessionDto;
  events: SessionEvent[];
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

/** Receive the history and live events of a session. */
export interface SubscribeMessage {
  type: 'subscribe';
  sessionId: string;
  requestId?: string;
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  sessionId: string;
  requestId?: string;
}

/**
 * Send a user message. Starts a turn, is queued behind the running turn, or
 * resumes a finished session.
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

/** Answer a `permission.request`. Reserved; rejected until approvals exist. */
export interface PermissionResponseMessage {
  type: 'permission.respond';
  sessionId: string;
  requestId: string;
  permissionRequestId: string;
  decision: 'allow' | 'deny';
  message?: string;
}

export type ClientMessage =
  | SubscribeMessage
  | UnsubscribeMessage
  | SendMessageMessage
  | InterruptMessage
  | PermissionResponseMessage;
