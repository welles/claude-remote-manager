/** Name of the app's in-process MCP server for Claude's tools. */
export const APP_MCP_SERVER = 'crm';
export const CREATE_PULL_REQUEST_TOOL = 'create_pull_request';
/** The tool's name as Claude Code reports it to `canUseTool`. */
export const CREATE_PULL_REQUEST_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${CREATE_PULL_REQUEST_TOOL}`;
/**
 * The app's tool that adds a repository to the running session, see
 * `RepositoryAdditions`.
 */
export const ADD_REPOSITORY_TOOL = 'add_repository';
export const ADD_REPOSITORY_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${ADD_REPOSITORY_TOOL}`;
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
 * The app's tools that never ask the user: showing a file (reads only the
 * session's directories), exposing or stopping a preview of the session's
 * own dev server (the owner decided so; the user sees each preview and can
 * stop it) and setting the session's title (never one the user chose).
 */
export const APP_TOOLS_WITHOUT_APPROVAL: ReadonlySet<string> = new Set([
  SHOW_FILE_TOOL_NAME,
  EXPOSE_PORT_TOOL_NAME,
  STOP_PREVIEW_TOOL_NAME,
  SET_SESSION_TITLE_TOOL_NAME,
]);

/**
 * Claude Code's tools that only read the session's files or keep its own
 * bookkeeping (also the session's title): they run unasked also during an
 * Autofix run. Everything
 * else asks there (also web access, which could send content away, and
 * subagents).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LSP',
  'TodoWrite',
  SET_SESSION_TITLE_TOOL_NAME,
  'ToolSearch',
  'TaskGet',
  'TaskList',
  'ListAgents',
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
