import {
  MAX_COMMIT_FILES,
  type CommitFileStat,
  type CommitSummary,
} from '@claude-remote-manager/shared-types';

/** Runs git in a session clone and returns its standard output. */
export type CloneGit = (args: string[]) => Promise<string>;

/** A full commit ID (SHA-1 or SHA-256). */
export const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Options of `git log` for {@link parseCommitLog}: every commit starts with
 * a record separator and its fields separated by NUL, then (with `-z`) its
 * file stats against the first parent (none for merge commits), renames
 * detected. No external diff tools or text conversions: they would run
 * commands from the repository's configuration.
 */
const LOG_OPTIONS = [
  'log',
  '--no-show-signature',
  '-z',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-mailmap',
  '--format=%x1e%H%x00%P%x00%an%x00%aI%x00%B',
];
/** With file stats (renames detected). */
const STAT_OPTIONS = ['--numstat', '-M'];

/** Longest message body kept (the rest is cut, marked). */
export const MAX_COMMIT_BODY = 20_000;

const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.*)$/s;

/**
 * Parses the output of `git log` with {@link LOG_OPTIONS}. File stats beyond
 * {@link MAX_COMMIT_FILES} per commit are counted, not listed.
 */
export function parseCommitLog(output: string): CommitSummary[] {
  const tokens = output.split('\0');
  const commits: CommitSummary[] = [];
  let current: CommitSummary | null = null;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index].replace(/^\n/, '');
    if (!token) {
      continue;
    }
    const stat = current ? NUMSTAT.exec(token) : null;
    if (current && stat) {
      let path = stat[3];
      let oldPath: string | null = null;
      if (!path) {
        // A rename or copy: old and new path follow as tokens of their own.
        oldPath = tokens[++index] ?? '';
        path = tokens[++index] ?? '';
      }
      const binary = stat[1] === '-' || stat[2] === '-';
      const file: CommitFileStat = {
        path,
        oldPath,
        binary,
        additions: binary ? 0 : Number(stat[1]),
        deletions: binary ? 0 : Number(stat[2]),
      };
      current.fileCount++;
      current.additions += file.additions;
      current.deletions += file.deletions;
      if (current.files.length < MAX_COMMIT_FILES) {
        current.files.push(file);
      }
      continue;
    }
    if (!token.startsWith('\x1e')) {
      // Not expected from git; never read as a commit.
      continue;
    }
    const sha = token.slice(1);
    const parents = tokens[++index] ?? '';
    const authorName = tokens[++index] ?? '';
    const authoredAt = tokens[++index] ?? '';
    const message = (tokens[++index] ?? '').replace(/\r\n/g, '\n');
    const newline = message.indexOf('\n');
    current = {
      sha,
      parents: parents.split(' ').filter(Boolean),
      subject: (newline < 0 ? message : message.slice(0, newline)).trim(),
      body: cutBody(newline < 0 ? '' : message.slice(newline + 1).trim()),
      authorName,
      authoredAt: isoDate(authoredAt),
      files: [],
      fileCount: 0,
      additions: 0,
      deletions: 0,
    };
    commits.push(current);
  }
  return commits;
}

function cutBody(body: string): string {
  return body.length > MAX_COMMIT_BODY
    ? `${body.slice(0, MAX_COMMIT_BODY)}\n[… cut]`
    : body;
}

/** git's strict ISO date as UTC ISO 8601 (as given if it cannot be read). */
function isoDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

/**
 * Commits reachable from `head` but from none of `exclude`, newest first
 * (at most `limit`), and how many there are in all. All revisions must be
 * full commit IDs or refs starting with `refs/` (never read as options).
 */
export async function listCommits(
  git: CloneGit,
  head: string,
  exclude: string[],
  limit: number,
  { stats = true }: { stats?: boolean } = {},
): Promise<{ commits: CommitSummary[]; count: number }> {
  const revisions = [head, ...exclude.map((rev) => `^${rev}`)];
  const count = Number(
    (await git(['rev-list', '--count', ...revisions, '--'])).trim(),
  );
  if (!count) {
    return { commits: [], count: 0 };
  }
  const commits = parseCommitLog(
    await git([
      ...LOG_OPTIONS,
      ...(stats ? STAT_OPTIONS : []),
      `--max-count=${limit}`,
      ...revisions,
      '--',
    ]),
  );
  return { commits, count: Math.max(count, commits.length) };
}

/** One commit by its full ID, without file stats. */
export async function readCommit(
  git: CloneGit,
  sha: string,
): Promise<CommitSummary | null> {
  const [commit] = parseCommitLog(
    await git([...LOG_OPTIONS, '--max-count=1', sha, '--']),
  );
  return commit?.sha === sha ? commit : null;
}
