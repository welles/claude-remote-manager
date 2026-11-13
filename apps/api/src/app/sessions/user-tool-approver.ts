import { randomUUID } from 'node:crypto';
import type {
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import type { PermissionResolutionCause } from '@claude-remote-manager/shared-types';
import {
  ToolApprover,
  type PermissionRequestInput,
  type PermissionResolvedInput,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from '../agent/tool-approval';
import {
  cancellation,
  describeRequest,
  resolveResponse,
  sessionAllowOffer,
} from './permission-requests';

interface PendingRequest {
  sessionId: string;
  event: PermissionRequestInput;
  input: Record<string, unknown>;
  updates: PermissionUpdate[];
  onResolve: (event: PermissionResolvedInput) => void;
  settle: (decision: ToolApprovalDecision) => void;
}

/**
 * Asks the user: every tool use that needs approval becomes a pending
 * request (shown in all clients of the session) until the user answers it
 * or it is cancelled. A request is cancelled when its abort signal fires
 * (the turn was interrupted, or the SDK gave up on it) or the session
 * service cancels the session's requests (end, process exit, shutdown), so
 * none stays pending without a process waiting for it. The first answer
 * counts; later answers find nothing pending and change nothing.
 */
export class UserToolApprover extends ToolApprover {
  private readonly pending = new Map<string, PendingRequest>();

  decide(request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
    const offer = sessionAllowOffer(request);
    const event = describeRequest(randomUUID(), request, offer?.offer ?? null);
    if (request.signal.aborted) {
      // Never shown: nobody waits for an answer.
      const { result, resolution } = cancellation(event, 'interrupted');
      return Promise.resolve({ ...result, resolution });
    }
    return new Promise((resolve) => {
      const onAbort = () => this.cancelRequest(event.requestId, 'interrupted');
      request.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(event.requestId, {
        sessionId: request.sessionId,
        event,
        input: request.input,
        updates: offer?.updates ?? [],
        onResolve: request.onResolve,
        settle: (decision) => {
          request.signal.removeEventListener('abort', onAbort);
          resolve(decision);
        },
      });
      request.onRequest(event);
    });
  }

  /**
   * Answers a pending request of the session. Returns the resolution, or
   * `null` if no such request is pending (unknown, or resolved already).
   * Throws BadRequestException for an answer that does not fit the
   * request; the request stays pending then.
   */
  respond(
    sessionId: string,
    requestId: string,
    response: unknown,
  ): PermissionResolvedInput | null {
    const entry = this.pending.get(requestId);
    if (!entry || entry.sessionId !== sessionId) {
      return null;
    }
    const { result, resolution } = resolveResponse(
      entry.event,
      entry.input,
      entry.updates,
      response,
    );
    this.finish(requestId, entry, result, resolution);
    return resolution;
  }

  /** Cancels all pending requests of a session; returns how many. */
  cancelSession(
    sessionId: string,
    cause: Exclude<PermissionResolutionCause, 'user'>,
  ): number {
    let count = 0;
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.sessionId === sessionId) {
        this.cancelRequest(requestId, cause);
        count++;
      }
    }
    return count;
  }

  /** Pending requests of a session, oldest first. */
  pendingRequests(sessionId: string): PermissionRequestInput[] {
    return [...this.pending.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => entry.event);
  }

  hasPending(sessionId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  private cancelRequest(
    requestId: string,
    cause: Exclude<PermissionResolutionCause, 'user'>,
  ): void {
    const entry = this.pending.get(requestId);
    if (entry) {
      const { result, resolution } = cancellation(entry.event, cause);
      this.finish(requestId, entry, result, resolution);
    }
  }

  private finish(
    requestId: string,
    entry: PendingRequest,
    result: PermissionResult,
    resolution: PermissionResolvedInput,
  ): void {
    this.pending.delete(requestId);
    // The resolution is logged before Claude Code continues.
    entry.onResolve(resolution);
    entry.settle({ ...result, resolution });
  }
}
