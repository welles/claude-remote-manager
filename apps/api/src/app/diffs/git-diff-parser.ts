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
  /** Added and removed lines (all of them, also when not kept). */
  additions: number;
  deletions: number;
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
        additions: 0,
        deletions: 0,
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
    if (line.startsWith('+')) {
      file.additions++;
    } else if (line.startsWith('-')) {
      file.deletions++;
    }
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

/**
 * Where the file list ends in the output of
 * `git diff --raw --numstat -p -z`: the raw records, then as many numstat
 * records, then an empty record (a NUL) before the patches. Returns the
 * changes and the offset of the first patch byte, or `null` while the
 * list is incomplete (`ended`: no more output will come).
 */
export function parseDiffHeader(
  output: Buffer,
  ended: boolean,
): { changes: RawChange[]; end: number } | null {
  let position = 0;
  const next = (): string | null => {
    const nul = output.indexOf(0, position);
    if (nul < 0) {
      return null;
    }
    const token = output.toString('utf8', position, nul);
    position = nul + 1;
    return token;
  };
  const tokens: string[] = [];
  // Raw records start with ":"; numstat records with a digit or "-".
  while (position < output.length && output[position] === 0x3a) {
    const record = next();
    if (record === null) {
      return null;
    }
    const letter = (record.split(' ')[4] ?? 'M')[0];
    const paths = letter === 'R' || letter === 'C' ? 2 : 1;
    tokens.push(record);
    for (let i = 0; i < paths; i++) {
      const path = next();
      if (path === null) {
        return null;
      }
      tokens.push(path);
    }
  }
  const count = tokens.filter((token) => token.startsWith(':')).length;
  if (count === 0) {
    return position >= output.length && !ended
      ? null
      : { changes: [], end: position };
  }
  for (let i = 0; i < count; i++) {
    const stat = next();
    if (stat === null) {
      return null;
    }
    tokens.push(stat);
    if (stat.split('\t')[2] === '') {
      for (let k = 0; k < 2; k++) {
        const path = next();
        if (path === null) {
          return null;
        }
        tokens.push(path);
      }
    }
  }
  if (position >= output.length && !ended) {
    // The separator before the patches may still come.
    return null;
  }
  if (output[position] === 0) {
    position++;
  }
  return { changes: parseRawNumstat(tokens.join('\0')), end: position };
}

/**
 * Parses the output of one `git diff --raw --numstat -p -z` run as it
 * streams: the file list first, then the patches, so file and patch come
 * from the same run and cannot be paired wrongly when the working tree
 * changes meanwhile (the n-th patch is the n-th listed file).
 */
export class DiffOutputParser {
  changes: RawChange[] | null = null;
  private head = Buffer.alloc(0);
  private rest = Buffer.alloc(0);

  constructor(private readonly patches: PatchParser) {}

  push(chunk: Buffer): void {
    if (this.changes === null) {
      this.head = Buffer.concat([this.head, chunk]);
      const header = parseDiffHeader(this.head, false);
      if (!header) {
        return;
      }
      this.changes = header.changes;
      chunk = this.head.subarray(header.end);
      this.head = Buffer.alloc(0);
    }
    this.lines(chunk);
  }

  end(): void {
    if (this.changes === null) {
      const header = parseDiffHeader(this.head, true);
      this.changes = header?.changes ?? [];
      if (header) {
        this.lines(this.head.subarray(header.end));
      }
    }
    if (this.rest.length > 0) {
      this.patches.push(this.rest.toString('utf8'));
      this.rest = Buffer.alloc(0);
    }
  }

  private lines(chunk: Buffer): void {
    let data = this.rest.length > 0 ? Buffer.concat([this.rest, chunk]) : chunk;
    let newline = data.indexOf(0x0a);
    while (newline >= 0) {
      const end =
        newline > 0 && data[newline - 1] === 0x0d ? newline - 1 : newline;
      this.patches.push(data.toString('utf8', 0, end));
      data = data.subarray(newline + 1);
      newline = data.indexOf(0x0a);
    }
    this.rest = Buffer.from(data);
  }
}
