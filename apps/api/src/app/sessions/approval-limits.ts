import { analyzeGitPushes } from '../agent/git-push-analysis';
import type { AgentToolCall } from '../agent/agent-runner';
import {
  ADD_REPOSITORY_TOOL_NAME,
  CREATE_PULL_REQUEST_TOOL_NAME,
  isGitPushCommand,
} from './approval-grants';

/** Reasons shown in the approval dialog ("Asked because: …"). */
export const APPROVAL_LIMIT_REASONS = {
  push: 'every git push needs your approval: it lets the credential helper write to the repository',
  pullRequest: 'creating a pull request always needs your approval',
  addRepository: 'adding a repository always needs your approval',
} as const;

/**
 * The app's limits ("Grenzen"): tool calls that always go to the user
 * (`canUseTool`), whatever the permission mode. Claude Code is told so by
 * a PreToolUse hook that answers `ask` (checked with the bundled Claude
 * Code: in `auto` mode such an ask is not left to the classifier but
 * reaches `canUseTool`; in `dontAsk` it is denied as before). Without it,
 * `auto` would let the classifier approve these calls, and the app's own
 * checks behind `canUseTool` would never see them:
 * - `git push` in any form the analysis recognizes: the approval is what
 *   lets the credential helper hand out a write token for the whole
 *   repository (see `ApprovalGrants`); a push the classifier allowed would
 *   get none and fail, one beyond the session branch must be seen anyway.
 *   The ask rule `Bash(git push:*)` covers plain `git push` only, not
 *   `git -C dir push` or `env … git push`;
 * - the app's `create_pull_request` and `add_repository`: their dialogs
 *   show what exactly would happen, and the tools run only for calls the
 *   user approved. Their MCP policy `always_ask` is left to the classifier
 *   in `auto` mode.
 *
 * Returns the reason for the dialog, or `null` for calls without limit.
 */
export function approvalLimit(call: AgentToolCall): string | null {
  if (call.toolName === 'Bash') {
    const command = call.input['command'];
    if (
      typeof command === 'string' &&
      (isGitPushCommand(command) || analyzeGitPushes(command, []).length > 0)
    ) {
      return APPROVAL_LIMIT_REASONS.push;
    }
    return null;
  }
  // The names are those of the app's in-process server: with
  // `strictMcpConfig` no other server can be called `crm`.
  if (call.toolName === CREATE_PULL_REQUEST_TOOL_NAME) {
    return APPROVAL_LIMIT_REASONS.pullRequest;
  }
  if (call.toolName === ADD_REPOSITORY_TOOL_NAME) {
    return APPROVAL_LIMIT_REASONS.addRepository;
  }
  return null;
}
