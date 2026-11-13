import type {
  DiffHunk,
  FileChangeStatus,
} from '@claude-remote-manager/shared-types';

/** A changed file as `git diff --raw --numstat -z` lists it. */
export interface RawChange {
  path: string;
  oldPath: string | null;
  status: FileChangeStatus;
  binary: boolean;
  additions: number;
  deletions: number;
}

const STATUS: Record<string, FileChangeStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type_changed',
};

/**
 * Parses the output of `git diff --raw --numstat -z`: first the raw
 * records (`:<modes> <hashes> <status>\0<path>\0[<new path>\0]`), then the
 * numstat records (`<added>\t<deleted>\t<path>\0`, for renames and copies
 * `<added>\t<deleted>\t\0<old>\0<new>\0`), in the same order. Paths are
 * taken verbatim (no quoting with `-z`), so odd names are safe.
 */
export function parseRawNumstat(output: string): RawChange[] {
  const tokens = output.split('\0');
  const changes: RawChange[] = [];
  let index = 0;
  while (index < tokens.length && tokens[index].startsWith(':')) {
    const fields = tokens[index].split(' ');
    const letter = (fields[4] ?? 'M')[0];
    const status = STATUS[letter] ?? 'modified';
    const twoPaths = letter === 'R' || letter === 'C';
    const first = tokens[index + 1] ?? '';
    const second = twoPaths ? (tokens[index + 2] ?? '') : null;
    changes.push({
      path: second ?? first,
      oldPath: twoPaths ? first : null,
      status,
      binary: false,
      additions: 0,
      deletions: 0,
    });
    index += twoPaths ? 3 : 2;
  }
  for (const change of changes) {
    const stat = tokens[index] ?? '';
    const [added, deleted, path] = stat.split('\t');
    // Renames and copies: the path field is empty, two paths follow.
    index += path === '' ? 3 : 1;
    if (added === '-' && deleted === '-') {
      change.binary = true;
    } else {
      change.additions = Number(added) || 0;
      change.deletions = Number(deleted) || 0;
    }
  }
  return changes;
}

/** The patch of one file: hunks, or why there are none. */
export interface FilePatch {
  hunks: DiffHunk[];
  /** Diff lines of the file (all of them, also when not kept). */
  lines: number;
  binary: boolean;
  /** The file's lines were left out (budget; `drop` mode). */
  dropped: boolean;
  /** Lines beyond the budget were left out (`truncate` mode). */
  truncated: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Splits the output of `git diff -p` into the patches of its files, line
 * by line (`push`), keeping hunk lines only while `keep` allows. Each file
 * starts with a `diff --git` line; content lines start with ` `, `+`, `-`
 * or `\`, so a file's content can never start a new file.
 */
export class PatchParser {
  readonly patches: FilePatch[] = [];
  private current: FilePatch | null = null;
  private hunk: DiffHunk | null = null;
  private inHeader = false;

  /**
   * @param keep Whether the next line of the current file may be kept,
   *   given how many lines the file has so far (0-based file index).
   */
  constructor(
    private readonly keep: (fileIndex: number, fileLines: number) => boolean,
    /** A file's lines kept so far were dropped again. */
    private readonly onDrop: (keptLines: number) => void = () => undefined,
    /**
     * What happens to a file that exceeds the budget: `drop` leaves all of
     * its lines out, `truncate` keeps the lines before.
     */
    private readonly mode: 'drop' | 'truncate' = 'drop',
  ) {}

  push(line: string): void {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ')) {
      this.current = {
        hunks: [],
        lines: 0,
        binary: false,
        dropped: false,
        truncated: false,
      };
      this.patches.push(this.current);
      this.hunk = null;
      this.inHeader = true;
      return;
    }
    const file = this.current;
    if (!file) {
      return;
    }
    if (this.inHeader) {
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
        file.binary = true;
        return;
      }
      if (!line.startsWith('@@')) {
        // Extended headers: modes, index, similarity, ---/+++.
        return;
      }
      this.inHeader = false;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      this.hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      if (!file.dropped && !file.truncated) {
        file.hunks.push(this.hunk);
      }
      return;
    }
    if (!this.hunk || !/^[ +\-\\]/.test(line)) {
      return;
    }
    file.lines++;
    if (file.dropped || file.truncated) {
      return;
    }
    if (this.keep(this.patches.length - 1, file.lines - 1)) {
      this.hunk.lines.push(line);
    } else {
      this.drop(file);
    }
  }

  private drop(file: FilePatch): void {
    if (this.mode === 'truncate') {
      file.truncated = true;
      // The hunk being cut matches its lines.
      const hunk = file.hunks.at(-1);
      if (hunk) {
        hunk.oldLines = hunk.lines.filter(
          (line) => !line.startsWith('+'),
        ).length;
        hunk.newLines = hunk.lines.filter(
          (line) => !line.startsWith('-'),
        ).length;
      }
      if (hunk && hunk.lines.length === 0) {
        file.hunks.pop();
      }
      return;
    }
    file.dropped = true;
    this.onDrop(file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0));
    file.hunks = [];
  }
}
