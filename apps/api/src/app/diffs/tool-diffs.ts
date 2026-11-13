import {
  MAX_TOOL_DIFF_LINES,
  type FileDiff,
  type SessionEventInput,
} from '@claude-remote-manager/shared-types';
import { diffTexts, fileDiff, parseHunks } from './file-diff';

/**
 * Claude Code's tools that change files. `MultiEdit` is gone from the
 * bundled Claude Code but appears in older transcripts.
 */
export const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (record: Record<string, unknown>, name: string) =>
  typeof record[name] === 'string' ? (record[name] as string) : null;

/** The file a file-changing tool call names. */
export function changedFile(name: string, input: unknown): string | null {
  if (!FILE_CHANGE_TOOLS.has(name) || !isRecord(input)) {
    return null;
  }
  return text(input, name === 'NotebookEdit' ? 'notebook_path' : 'file_path');
}

/** A diff of two texts; `truncated` without hunks when too large. */
function textsDiff(
  path: string,
  before: string | null,
  after: string,
  { approximate }: { approximate: boolean },
): FileDiff {
  const hunks = diffTexts(before, after);
  const diff = fileDiff(
    path,
    before === null ? 'added' : 'modified',
    hunks ?? [],
    {
      maxLines: MAX_TOOL_DIFF_LINES,
      approximate,
    },
  );
  return hunks ? diff : { ...diff, truncated: true };
}

/**
 * The diff of a file change from Claude Code's structured tool result
 * (`tool_use_result` of the SDK's user message): `structuredPatch` of
 * `Edit` and `Write` (with the file's line numbers), the cell sources of
 * `NotebookEdit`. `null` for other tools, failed or staged changes, and
 * results it does not recognize.
 */
export function diffFromToolResult(
  name: string,
  input: unknown,
  result: unknown,
): FileDiff | null {
  if (!isRecord(result) || result['staged'] === true) {
    return null;
  }
  const path = text(result, 'filePath') ?? changedFile(name, input);
  if (!path) {
    return null;
  }
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const hunks = parseHunks(result['structuredPatch']);
      if (!hunks) {
        return null;
      }
      const created = result['type'] === 'create';
      const content = text(result, 'content');
      if (hunks.length === 0 && created && content !== null) {
        // A new file: everything was added.
        return textsDiff(path, null, content, { approximate: false });
      }
      return fileDiff(path, created ? 'added' : 'modified', hunks, {
        maxLines: MAX_TOOL_DIFF_LINES,
      });
    }
    case 'NotebookEdit': {
      if (typeof result['error'] === 'string' && result['error']) {
        return null;
      }
      const after = text(result, 'new_source') ?? '';
      const before = text(result, 'old_source');
      const mode = text(result, 'edit_mode');
      return textsDiff(
        path,
        mode === 'insert' ? null : (before ?? ''),
        mode === 'delete' ? '' : after,
        // Lines count within the cell.
        { approximate: true },
      );
    }
    default:
      return null;
  }
}

/**
 * The diff of a file change known only from the tool's input (histories
 * without stored diffs, approvals of files that cannot be read): an
 * `Edit`'s old and new text, a `Write`'s content as added lines, a
 * notebook cell's new source. Always `approximate`.
 */
export function diffFromToolInput(
  name: string,
  input: unknown,
): FileDiff | null {
  const path = changedFile(name, input);
  if (!path || !isRecord(input)) {
    return null;
  }
  switch (name) {
    case 'Edit': {
      const before = text(input, 'old_string');
      const after = text(input, 'new_string');
      return before === null || after === null
        ? null
        : textsDiff(path, before, after, { approximate: true });
    }
    case 'MultiEdit': {
      const edits = Array.isArray(input['edits']) ? input['edits'] : [];
      const before = edits
        .filter(isRecord)
        .map((edit) => text(edit, 'old_string') ?? '')
        .join('\n');
      const after = edits
        .filter(isRecord)
        .map((edit) => text(edit, 'new_string') ?? '')
        .join('\n');
      return textsDiff(path, before, after, { approximate: true });
    }
    case 'Write': {
      const content = text(input, 'content');
      return content === null
        ? null
        : textsDiff(path, null, content, { approximate: true });
    }
    case 'NotebookEdit': {
      const mode = text(input, 'edit_mode');
      return textsDiff(
        path,
        null,
        mode === 'delete' ? '' : (text(input, 'new_source') ?? ''),
        { approximate: true },
      );
    }
    default:
      return null;
  }
}

/**
 * The change a file tool call would make, for its approval: against the
 * file's current content (`current`: `null` when the file does not exist,
 * `undefined` when it could not be read). Falls back to the input's diff.
 */
export function proposedDiff(
  name: string,
  input: unknown,
  current: string | null | undefined,
): FileDiff | null {
  const path = changedFile(name, input);
  if (!path || !isRecord(input) || current === undefined) {
    return diffFromToolInput(name, input);
  }
  if (name === 'Write') {
    const content = text(input, 'content');
    return content === null
      ? null
      : textsDiff(path, current, content, { approximate: false });
  }
  if (name === 'Edit' && current !== null) {
    const before = text(input, 'old_string');
    const after = text(input, 'new_string');
    if (before && after !== null && current.includes(before)) {
      const changed =
        input['replace_all'] === true
          ? current.split(before).join(after)
          : current.replace(before, () => after);
      return textsDiff(path, current, changed, { approximate: false });
    }
  }
  return diffFromToolInput(name, input);
}

type HistoryLike = { event: SessionEventInput; at: string | null };

/**
 * Adds a diff from the tool's input after the result of every successful
 * file change that has no stored diff (histories from before diffs were
 * stored, or results Claude Code reported without structured output).
 */
export function withInputDiffs<T extends HistoryLike>(
  items: T[],
  make: (event: SessionEventInput, at: string | null) => T,
): T[] {
  const diffed = new Set<string>();
  const calls = new Map<string, { name: string; input: unknown }>();
  for (const { event } of items) {
    if (event.type === 'tool.diff') {
      diffed.add(event.toolUseId);
    } else if (
      event.type === 'tool.call' &&
      FILE_CHANGE_TOOLS.has(event.name)
    ) {
      calls.set(event.toolUseId, { name: event.name, input: event.input });
    }
  }
  if (calls.size === 0) {
    return items;
  }
  const result: T[] = [];
  for (const item of items) {
    result.push(item);
    const event = item.event;
    if (
      event.type === 'tool.result' &&
      !event.isError &&
      !diffed.has(event.toolUseId)
    ) {
      const call = calls.get(event.toolUseId);
      const diff = call ? diffFromToolInput(call.name, call.input) : null;
      if (diff) {
        diffed.add(event.toolUseId);
        result.push(
          make(
            {
              type: 'tool.diff',
              toolUseId: event.toolUseId,
              diff,
              source: 'input',
              parentToolUseId: event.parentToolUseId,
            },
            item.at,
          ),
        );
      }
    }
  }
  return result;
}
