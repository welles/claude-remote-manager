/** A tool use Claude Code asks the host to decide (`canUseTool`). */
export interface ToolApprovalRequest {
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  /** Prompt sentence from Claude Code, e.g. "Claude wants to run …". */
  title: string | null;
  description: string | null;
  /** For MCP tools: the server and where it is defined (`sdk`: ours). */
  mcpServer: { name: string; source: string } | null;
  signal: AbortSignal;
}

export type ToolApprovalDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | {
      behavior: 'deny';
      message: string;
      /** `no_approval_ui`: no dialog exists to ask; `user`: the user said no. */
      reason: 'no_approval_ui' | 'user';
    };

/** What Claude is told, and the user shown, when a tool use needs approval. */
export const NO_APPROVAL_UI_MESSAGE =
  'Approval dialogs are not implemented in Claude Remote Manager yet, so this ' +
  'tool use was denied automatically. Continue without it if you can, ' +
  'otherwise tell the user what you wanted to do.';

/**
 * Decides tool uses that need the user's approval. Every such decision of
 * a session goes through here, so the app knows what the user approved
 * (an approved `git push` lets the credential helper hand out a write
 * token; an approved `create_pull_request` call lets the tool run).
 * An abstract class to serve as Nest token: the approval dialogs replace
 * the default implementation, tests use a fake.
 */
export abstract class ToolApprover {
  abstract decide(request: ToolApprovalRequest): Promise<ToolApprovalDecision>;
}

/** Until approval dialogs exist: every tool use that needs approval is denied. */
export class NoApprovalUiApprover extends ToolApprover {
  async decide(): Promise<ToolApprovalDecision> {
    return {
      behavior: 'deny',
      message: NO_APPROVAL_UI_MESSAGE,
      reason: 'no_approval_ui',
    };
  }
}
