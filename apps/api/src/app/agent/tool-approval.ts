import type {
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  GitPushAnalysis,
  PermissionRequestEvent,
  PermissionResolutionCause,
  PermissionResolvedEvent,
  PullRequestCall,
} from '@claude-remote-manager/shared-types';

/** A `permission.request` event before the log assigns `seq` and `at`. */
export type PermissionRequestInput = Omit<PermissionRequestEvent, 'seq' | 'at'>;
/** A `permission.resolved` event before the log assigns `seq` and `at`. */
export type PermissionResolvedInput = Omit<
  PermissionResolvedEvent,
  'seq' | 'at'
>;

/** A tool use Claude Code asks the host to decide (`canUseTool`). */
export interface ToolApprovalRequest {
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  /** Prompt sentence from Claude Code, e.g. "Claude wants to run …". */
  title: string | null;
  description: string | null;
  displayName: string | null;
  decisionReason: string | null;
  blockedPath: string | null;
  /** Set when a subagent asks. */
  agentId: string | null;
  /** For MCP tools: the server and where it is defined (`sdk`: ours). */
  mcpServer: { name: string; source: string } | null;
  /**
   * For Bash commands that run `git push`: what each push would update,
   * with warnings for anything beyond the session branch (the approval
   * lets the credential helper write to the whole repository).
   */
  gitPushes: GitPushAnalysis[];
  /** For the app's `create_pull_request` tool: the pull request. */
  pullRequest: PullRequestCall | null;
  /** Claude Code's suggestions for not asking again (`canUseTool`). */
  suggestions: PermissionUpdate[];
  /** Claude Code says not to offer "don't ask again" for this request. */
  suppressAlwaysAllow: boolean;
  signal: AbortSignal;
  /** The request is pending now (to show it to the user). */
  onRequest(event: PermissionRequestInput): void;
  /** The request was answered or cancelled. */
  onResolve(event: PermissionResolvedInput): void;
}

/** The answer for Claude Code plus how the request was resolved. */
export type ToolApprovalDecision = PermissionResult & {
  resolution: PermissionResolvedInput;
};

/**
 * Decides tool uses that need the user's approval. Every such decision of
 * a session goes through here, so the app knows what the user approved
 * (an approved `git push` lets the credential helper hand out a write
 * token; an approved `create_pull_request` call lets the tool run).
 * An abstract class to serve as Nest token.
 */
export abstract class ToolApprover {
  /** Waits for the user's decision (or the request's cancellation). */
  abstract decide(request: ToolApprovalRequest): Promise<ToolApprovalDecision>;
  /**
   * Answers a pending request; `null` if it is not pending (unknown or
   * resolved already).
   */
  abstract respond(
    sessionId: string,
    requestId: string,
    response: unknown,
  ): PermissionResolvedInput | null;
  /** Cancels the pending requests of a session; returns how many. */
  abstract cancelSession(
    sessionId: string,
    cause: Exclude<PermissionResolutionCause, 'user'>,
  ): number;
  abstract pendingRequests(sessionId: string): PermissionRequestInput[];
  abstract hasPending(sessionId: string): boolean;
}
