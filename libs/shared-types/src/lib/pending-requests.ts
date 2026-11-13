import type { PermissionRequestEvent } from './session-events';

/**
 * What a pending approval request asks for, without its details (no
 * command, path or text): enough to say in the session list what a
 * session needs.
 * - `command`: a shell command; `push`: one that pushes with git;
 * - `edit`: a file change; `pull-request`: creating a pull request;
 * - `tool`: any other tool use;
 * - `question`: Claude asks; `plan`: a plan to approve.
 */
export type PendingRequestKind =
  | 'command'
  | 'push'
  | 'edit'
  | 'pull-request'
  | 'tool'
  | 'question'
  | 'plan';

/** The approval requests a session waits for (`SessionDto.pendingRequests`). */
export interface PendingRequestSummary {
  /** What the oldest request asks for (the one answered first). */
  kind: PendingRequestKind;
  /** How many requests wait. */
  count: number;
  /** For a `question`: how many questions it asks. */
  questions: number;
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export function pendingRequestKind(
  request: Pick<
    PermissionRequestEvent,
    'kind' | 'toolName' | 'gitPushes' | 'pullRequest'
  >,
): PendingRequestKind {
  if (request.kind === 'question' || request.kind === 'plan') {
    return request.kind;
  }
  if (request.pullRequest) {
    return 'pull-request';
  }
  if (request.toolName === 'Bash') {
    return request.gitPushes.length > 0 ? 'push' : 'command';
  }
  return EDIT_TOOLS.has(request.toolName) ? 'edit' : 'tool';
}

/** The summary of pending requests, oldest first; `null` for none. */
export function summarizePendingRequests(
  requests: readonly Pick<
    PermissionRequestEvent,
    'kind' | 'toolName' | 'gitPushes' | 'pullRequest' | 'questions'
  >[],
): PendingRequestSummary | null {
  const first = requests[0];
  if (!first) {
    return null;
  }
  return {
    kind: pendingRequestKind(first),
    count: requests.length,
    questions: first.kind === 'question' ? (first.questions?.length ?? 0) : 0,
  };
}

/**
 * What the user is asked for, e.g. `Approve command`, `2 questions`,
 * `Plan ready`, with `· 2 more` when more requests wait.
 */
export function pendingRequestLabel(summary: PendingRequestSummary): string {
  let label: string;
  switch (summary.kind) {
    case 'command':
      label = 'Approve command';
      break;
    case 'push':
      label = 'Approve push';
      break;
    case 'edit':
      label = 'Approve edit';
      break;
    case 'pull-request':
      label = 'Approve pull request';
      break;
    case 'question':
      label =
        summary.questions > 1 ? `${summary.questions} questions` : 'Question';
      break;
    case 'plan':
      label = 'Plan ready';
      break;
    default:
      label = 'Approve tool';
  }
  return summary.count > 1 ? `${label} · ${summary.count - 1} more` : label;
}
