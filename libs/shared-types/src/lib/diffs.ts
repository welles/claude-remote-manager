/**
 * Diffs of files: of one tool call that changed a file (in the
 * conversation and in approval requests) and of whole sessions.
 */

/**
 * One hunk of a unified diff. Every line starts with `' '` (context),
 * `'-'` (removed), `'+'` (added) or `'\'` ("No newline at end of file").
 */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export type FileChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type_changed';

/** The changes of one file. */
export interface FileDiff {
  /** Path of the file (relative to the repository in session diffs). */
  path: string;
  /** Previous path of a renamed or copied file. */
  oldPath: string | null;
  status: FileChangeStatus;
  /** Binary content: no hunks. */
  binary: boolean;
  /** Added and removed lines (of the whole change, also when truncated). */
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** Lines were left out of `hunks` because the change is too large. */
  truncated: boolean;
  /**
   * Known only from the tool's input (e.g. an `Edit`'s old and new text):
   * line numbers count from the changed text, not from the file, and the
   * file's previous content may be unknown.
   */
  approximate: boolean;
}

/** Where the diff of a tool call comes from. */
export type ToolDiffSource = 'result' | 'input' | 'proposed';

/** Most diff lines a tool call's diff carries. */
export const MAX_TOOL_DIFF_LINES = 2000;
