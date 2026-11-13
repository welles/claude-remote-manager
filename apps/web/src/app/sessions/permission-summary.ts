import type { PermissionRequestEvent } from '@claude-remote-manager/shared-types';

/** One labelled piece of what Claude wants to do. */
export interface SummaryField {
  label: string;
  value: string;
  /** Shown as code (monospace, wrapped), e.g. a command or file content. */
  code: boolean;
}

/** What a tool use would do, readable without the raw JSON. */
export interface RequestSummary {
  /** Short name of the action, e.g. "Run a command". */
  action: string;
  fields: SummaryField[];
}

/** Longer content is cut in the dialog (the raw input stays available). */
export const MAX_FIELD_LENGTH = 4000;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};

function shorten(value: string): string {
  return value.length > MAX_FIELD_LENGTH
    ? `${value.slice(0, MAX_FIELD_LENGTH)}\n… (${value.length - MAX_FIELD_LENGTH} more characters)`
    : value;
}

/** Name of one of the app's or another MCP server's tools, readable. */
function mcpName(toolName: string): string | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match ? `${match[2]} (${match[1]})` : null;
}

/**
 * A readable summary of a tool use for the approval dialog: the command,
 * the file and the change, the URL, … Unknown tools show their input.
 */
export function requestSummary(
  request: PermissionRequestEvent,
): RequestSummary {
  const input = record(request.input);
  const fields: SummaryField[] = [];
  const add = (label: string, value: unknown, code = false) => {
    if (typeof value === 'string' && value !== '') {
      fields.push({ label, value: shorten(value), code });
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      fields.push({ label, value: String(value), code });
    }
  };
  let action = request.displayName ?? request.toolName;
  // The change itself is shown as a diff.
  const diffed = Boolean(request.diff);
  switch (request.toolName) {
    case 'Bash':
      action = 'Run a command';
      add('Command', input['command'], true);
      add('Purpose', input['description']);
      break;
    case 'Edit':
      action = 'Edit a file';
      add('File', input['file_path'], true);
      if (!diffed) {
        add('Replace', input['old_string'], true);
        add('With', input['new_string'], true);
      }
      if (input['replace_all'] === true) {
        add('All occurrences', 'yes');
      }
      break;
    case 'MultiEdit':
      action = 'Edit a file';
      add('File', input['file_path'], true);
      add('Changes', JSON.stringify(input['edits'], null, 2), true);
      break;
    case 'Write':
      action = 'Write a file';
      add('File', input['file_path'], true);
      if (!diffed) {
        add('Content', input['content'], true);
      }
      break;
    case 'NotebookEdit':
      action = 'Edit a notebook';
      add('Notebook', input['notebook_path'], true);
      add('Cell', input['cell_id'], true);
      if (!diffed) {
        add('New content', input['new_source'], true);
      }
      break;
    case 'Read':
      action = 'Read a file';
      add('File', input['file_path'], true);
      break;
    case 'Glob':
    case 'Grep':
      action = 'Search files';
      add('Pattern', input['pattern'], true);
      add('In', input['path'], true);
      break;
    case 'WebFetch':
      action = 'Fetch a web page';
      add('URL', input['url'], true);
      add('To find out', input['prompt']);
      break;
    case 'WebSearch':
      action = 'Search the web';
      add('Query', input['query']);
      break;
    case 'EnterPlanMode':
      action = 'Switch to plan mode';
      break;
    default: {
      const name = mcpName(request.toolName);
      if (request.pullRequest) {
        action = 'Create a pull request';
      } else if (name) {
        action = `Use ${name}`;
      }
      if (!request.pullRequest && Object.keys(input).length > 0) {
        add('Input', JSON.stringify(input, null, 2), true);
      }
    }
  }
  if (request.blockedPath) {
    add('Path concerned', request.blockedPath, true);
  }
  return { action, fields };
}
