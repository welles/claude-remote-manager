/** Name of the app's in-process MCP server for Claude's tools. */
export const APP_MCP_SERVER = 'crm';
export const CREATE_PULL_REQUEST_TOOL = 'create_pull_request';
/** The tool's name as Claude Code reports it to `canUseTool`. */
export const CREATE_PULL_REQUEST_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${CREATE_PULL_REQUEST_TOOL}`;
/**
 * The app's tool that replies on a review thread of one of the session's
 * pull requests and/or resolves it (the backend does it with an
 * installation token; `gh` stays read-only). Asks as the permission mode
 * says; during an Autofix run replies, and resolving after a push, run
 * unasked.
 */
export const REPLY_TO_REVIEW_THREAD_TOOL = 'reply_to_review_thread';
export const REPLY_TO_REVIEW_THREAD_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${REPLY_TO_REVIEW_THREAD_TOOL}`;
/**
 * The app's tool that merges one of the session's pull requests (the
 * backend does it with an installation token). Asks as the permission mode
 * says; runs unasked when automerge is on for the pull request and it is
 * ready (see `PrAutomationService.mayMergeUnasked`).
 */
export const MERGE_PULL_REQUEST_TOOL = 'merge_pull_request';
export const MERGE_PULL_REQUEST_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${MERGE_PULL_REQUEST_TOOL}`;
/**
 * The app's tool that switches autofix, automerge or autoclose of one of
 * the session's open pull requests, like the switches of the session view.
 * Asks as the permission mode says; during an Autofix run it can only turn
 * switches off (GitHub's content must not turn on merging).
 */
export const SET_PR_AUTOMATION_TOOL = 'set_pr_automation';
export const SET_PR_AUTOMATION_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${SET_PR_AUTOMATION_TOOL}`;
/**
 * The app's tool that adds a repository to the running session, see
 * `RepositoryAdditions`.
 */
export const ADD_REPOSITORY_TOOL = 'add_repository';
export const ADD_REPOSITORY_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${ADD_REPOSITORY_TOOL}`;
/**
 * The app's tool that adds another clone of one of the session's
 * repositories on a branch of its own (`claude/<slug>-2`, …), for a further
 * pull request in parallel (no approval needed: it only clones a repository
 * the session has already; pushes and pull requests ask as before).
 */
export const ADD_BRANCH_TOOL = 'add_branch';
export const ADD_BRANCH_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${ADD_BRANCH_TOOL}`;
/**
 * The app's tool that makes another of the session's clones Claude Code's
 * working directory from the next turn (no approval needed: it only
 * restarts Claude Code in a directory of the session).
 */
export const SWITCH_DIRECTORY_TOOL = 'switch_directory';
export const SWITCH_DIRECTORY_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${SWITCH_DIRECTORY_TOOL}`;
/** The app's tool that shows a file to the user (no approval needed). */
export const SHOW_FILE_TOOL = 'show_file';
export const SHOW_FILE_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${SHOW_FILE_TOOL}`;
/** The app's tools for previews of dev servers (no approval needed). */
export const EXPOSE_PORT_TOOL = 'expose_port';
export const EXPOSE_PORT_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${EXPOSE_PORT_TOOL}`;
export const STOP_PREVIEW_TOOL = 'stop_preview';
export const STOP_PREVIEW_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${STOP_PREVIEW_TOOL}`;
/** The app's tool that sets the session's title (no approval needed). */
export const SET_SESSION_TITLE_TOOL = 'set_session_title';
export const SET_SESSION_TITLE_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${SET_SESSION_TITLE_TOOL}`;
/**
 * The app's tool with which Claude says what the session waits for after
 * the turn (no approval needed).
 */
export const SET_WAITING_STATE_TOOL = 'set_waiting_state';
export const SET_WAITING_STATE_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${SET_WAITING_STATE_TOOL}`;
/**
 * The app's tool with which Claude asks for the owner's decision on a
 * review finding: it pauses automerge until the owner's next message.
 */
export const REQUEST_OWNER_DECISION_TOOL = 'request_owner_decision';
export const REQUEST_OWNER_DECISION_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${REQUEST_OWNER_DECISION_TOOL}`;
/**
 * The app's tool with which Claude asks for an independent review of the
 * session's changes (no approval needed: it only starts a read-only
 * reviewer, as the session's review mode allows).
 */
export const REQUEST_REVIEW_TOOL = 'request_review';
export const REQUEST_REVIEW_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${REQUEST_REVIEW_TOOL}`;
/**
 * The app's tools that never ask the user: showing a file (reads only the
 * session's directories), exposing or stopping a preview of the session's
 * own dev server (the owner decided so; the user sees each preview and can
 * stop it), setting the session's title (never one the user chose),
 * saying what the session waits for, asking for the owner's decision
 * (it only pauses automerge), adding a further branch of a repository
 * of the session (the owner decided so; it only clones a repository the
 * session has already), switching the working directory to another of
 * the session's clones, and asking for an independent review (it only
 * starts a read-only reviewer, as the session's review mode allows).
 */
export const APP_TOOLS_WITHOUT_APPROVAL: ReadonlySet<string> = new Set([
  SHOW_FILE_TOOL_NAME,
  EXPOSE_PORT_TOOL_NAME,
  STOP_PREVIEW_TOOL_NAME,
  SET_SESSION_TITLE_TOOL_NAME,
  SET_WAITING_STATE_TOOL_NAME,
  REQUEST_OWNER_DECISION_TOOL_NAME,
  ADD_BRANCH_TOOL_NAME,
  SWITCH_DIRECTORY_TOOL_NAME,
  REQUEST_REVIEW_TOOL_NAME,
]);

/** Commands that run the command after them. */
const COMMAND_WRAPPERS = new Set([
  'env',
  'command',
  'exec',
  'time',
  'nice',
  'nohup',
  'sudo',
]);

/** Options of git that take a separate value (`git -C dir push`). */
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
]);

/**
 * Whether a shell command runs `git push` in one of its parts. Used to
 * notice pushes of a session (to record what reached the remote); it errs
 * towards "no" for unusual forms (aliases, scripts that push), which are
 * then noticed with the next push or refresh.
 */
export function isGitPushCommand(command: string): boolean {
  for (const part of command.split(/&&|\|\||[;&|\n()`{}]|\$\(/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    // The command word: after variable assignments and simple wrappers.
    let index = 0;
    while (
      index < words.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]) ||
        COMMAND_WRAPPERS.has(words[index]))
    ) {
      index++;
    }
    if (index >= words.length || !/(^|\/)git$/.test(words[index])) {
      continue;
    }
    let next = index + 1;
    while (next < words.length && words[next].startsWith('-')) {
      next += GIT_OPTIONS_WITH_VALUE.has(words[next]) ? 2 : 1;
    }
    if (words[next] === 'push') {
      return true;
    }
  }
  return false;
}
