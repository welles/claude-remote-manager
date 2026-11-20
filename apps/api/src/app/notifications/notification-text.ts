import type {
  ApprovalAction,
  PermissionRequestEvent,
  PullRequestDto,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { shorten, shortenMiddle } from './notification';

/** Longest line of details (command, path, question) in a notification. */
export const DETAIL_LENGTH = 160;
/** Longest session title in a notification. */
const TITLE_LENGTH = 60;

/** `Fix login · acme/app + acme/lib`: where the event happened. */
export function sessionContext(session: SessionDto): string {
  const title = shorten(session.title || 'Untitled session', TITLE_LENGTH);
  const workspace = session.directories
    .map((directory) =>
      directory.kind === 'scratch'
        ? 'scratch'
        : (directory.repository?.fullName ?? null),
    )
    .filter((name): name is string => name !== null)
    .join(' + ');
  return workspace ? `${title} · ${workspace}` : title;
}

/** A path relative to the session's directory it lies in, if any. */
function relativePath(path: string, session: SessionDto): string {
  for (const directory of session.directories) {
    const base = directory.path.replace(/\/+$/, '');
    if (path.startsWith(`${base}/`)) {
      const name = directory.repository?.fullName.split('/').at(-1);
      const relative = path.slice(base.length + 1);
      return directory.role === 'main' || !name
        ? relative
        : `${name}/${relative}`;
    }
  }
  return path;
}

const text = (input: Record<string, unknown>, name: string) =>
  typeof input[name] === 'string' ? (input[name] as string) : null;

/**
 * What an approval request is about, in two parts: the action ("Run a
 * command") and the detail (the command, shortened; the file path; the
 * URL), enough to decide from the notification.
 */
export function approvalSummary(
  request: PermissionRequestEvent,
  session: SessionDto,
): { action: string; detail: string } {
  const input =
    typeof request.input === 'object' && request.input !== null
      ? (request.input as Record<string, unknown>)
      : {};
  const path = (name: string) => {
    const value = text(input, name);
    return value
      ? shortenMiddle(relativePath(value, session), DETAIL_LENGTH)
      : '';
  };
  if (request.kind === 'question') {
    const first = request.questions?.[0];
    const more = (request.questions?.length ?? 0) > 1 ? ' (and more)' : '';
    return {
      action: 'Claude asks',
      detail: first ? shorten(`${first.question}${more}`, DETAIL_LENGTH) : '',
    };
  }
  if (request.kind === 'plan') {
    const heading =
      request.plan
        ?.split('\n')
        .map((line) => line.replace(/^#+\s*/, '').trim())
        .find(Boolean) ?? '';
    return {
      action: 'Plan to review',
      detail: shorten(heading, DETAIL_LENGTH),
    };
  }
  if (request.pullRequest) {
    const pr = request.pullRequest;
    return {
      action: 'Create a pull request',
      detail: shorten(
        `${pr.repository ?? ''}${pr.base ? ` into ${pr.base}` : ''}: ${pr.title}`,
        DETAIL_LENGTH,
      ),
    };
  }
  if (request.reviewThreadReply) {
    const reply = request.reviewThreadReply;
    const action =
      reply.body && reply.resolve
        ? 'Reply to and resolve a review thread'
        : reply.body
          ? 'Reply to a review thread'
          : 'Resolve a review thread';
    return {
      action,
      detail: shorten(
        `${reply.repository ?? ''}#${reply.pullRequest ?? '?'}${reply.body ? `: ${reply.body.replace(/\s+/g, ' ').trim()}` : ''}`,
        DETAIL_LENGTH,
      ),
    };
  }
  if (request.pullRequestMerge) {
    const merge = request.pullRequestMerge;
    return {
      action: 'Merge a pull request',
      detail: shorten(
        `${merge.repository ?? ''}#${merge.pullRequest ?? '?'}${merge.title ? `: ${merge.title}` : ''}`,
        DETAIL_LENGTH,
      ),
    };
  }
  if (request.repositoryAddition) {
    const addition = request.repositoryAddition;
    const from =
      addition.source === 'github'
        ? 'GitHub'
        : addition.source === 'project'
          ? 'local project'
          : (addition.url ?? 'URL');
    return {
      action: 'Add a repository',
      detail: shortenMiddle(
        `${addition.repository} (${from})${addition.baseBranch ? ` from ${addition.baseBranch}` : ''}`,
        DETAIL_LENGTH,
      ),
    };
  }
  switch (request.toolName) {
    case 'Bash':
      return {
        action: request.gitPushes.length > 0 ? 'Push' : 'Run a command',
        detail: shortenMiddle(text(input, 'command') ?? '', DETAIL_LENGTH),
      };
    case 'Edit':
    case 'MultiEdit':
      return { action: 'Edit a file', detail: path('file_path') };
    case 'Write':
      return { action: 'Write a file', detail: path('file_path') };
    case 'NotebookEdit':
      return { action: 'Edit a notebook', detail: path('notebook_path') };
    case 'Read':
      return { action: 'Read a file', detail: path('file_path') };
    case 'Glob':
    case 'Grep':
      return {
        action: 'Search files',
        detail: shorten(
          `${text(input, 'pattern') ?? ''}${text(input, 'path') ? ` in ${relativePath(text(input, 'path') as string, session)}` : ''}`,
          DETAIL_LENGTH,
        ),
      };
    case 'WebFetch':
      return {
        action: 'Fetch a web page',
        detail: shortenMiddle(text(input, 'url') ?? '', DETAIL_LENGTH),
      };
    case 'WebSearch':
      return {
        action: 'Search the web',
        detail: shorten(text(input, 'query') ?? '', DETAIL_LENGTH),
      };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(request.toolName);
      return {
        action: mcp
          ? `Use ${mcp[2]} (${mcp[1]})`
          : (request.displayName ?? `Use ${request.toolName}`),
        detail: shorten(
          request.title ?? request.blockedPath ?? request.description ?? '',
          DETAIL_LENGTH,
        ),
      };
    }
  }
}

/**
 * Buttons an approval notification offers. Only for tool uses: Allow
 * (once) and Deny. A `git push` that would update more than the session
 * branch (or force, delete, push everything) gets no Allow: its warnings
 * do not fit a notification, so it is decided in the session. Questions
 * and plans need the session too.
 */
export function approvalActions(
  request: Pick<PermissionRequestEvent, 'kind' | 'gitPushes'>,
): ApprovalAction[] {
  if (request.kind !== 'tool') {
    return [];
  }
  const risky = request.gitPushes.some(
    (push) => !push.sessionBranchOnly || push.warnings.length > 0,
  );
  return risky ? ['deny'] : ['allow', 'deny'];
}

export function pullRequestLabel(pullRequest: PullRequestDto): string {
  return `${pullRequest.repository}#${pullRequest.number}`;
}
