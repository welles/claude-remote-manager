import { structuredPatch } from 'diff';
import type {
  DiffHunk,
  FileChangeStatus,
  FileDiff,
} from '@claude-remote-manager/shared-types';

/** Texts larger than this together are not diffed (too slow). */
export const MAX_DIFF_INPUT = 2 * 1024 * 1024;
/** Diffing gives up after this long (jsdiff's `timeout`). */
const DIFF_TIMEOUT_MS = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Added and removed lines of hunks. */
export function countChanges(hunks: DiffHunk[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        additions++;
      } else if (line.startsWith('-')) {
        deletions++;
      }
    }
  }
  return { additions, deletions };
}

/**
 * Keeps at most `maxLines` diff lines: whole hunks while they fit, then the
 * beginning of the next one (its line counts are cut to match).
 */
export function capHunks(
  hunks: DiffHunk[],
  maxLines: number,
): { hunks: DiffHunk[]; truncated: boolean } {
  const kept: DiffHunk[] = [];
  let remaining = maxLines;
  for (const hunk of hunks) {
    if (hunk.lines.length <= remaining) {
      kept.push(hunk);
      remaining -= hunk.lines.length;
      continue;
    }
    if (remaining > 0) {
      const lines = hunk.lines.slice(0, remaining);
      kept.push({
        ...hunk,
        oldLines: lines.filter((line) => !line.startsWith('+')).length,
        newLines: lines.filter((line) => !line.startsWith('-')).length,
        lines,
      });
    }
    return { hunks: kept, truncated: true };
  }
  return { hunks: kept, truncated: false };
}

/** Hunks from a structured patch as Claude Code or jsdiff report it. */
export function parseHunks(value: unknown): DiffHunk[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const hunks: DiffHunk[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !Array.isArray(item['lines']) ||
      !item['lines'].every((line) => typeof line === 'string')
    ) {
      return null;
    }
    const number = (name: string) =>
      typeof item[name] === 'number' && Number.isFinite(item[name])
        ? (item[name] as number)
        : 0;
    hunks.push({
      oldStart: number('oldStart'),
      oldLines: number('oldLines'),
      newStart: number('newStart'),
      newLines: number('newLines'),
      lines: item['lines'] as string[],
    });
  }
  return hunks;
}

/** A file diff from hunks, counted and capped. */
export function fileDiff(
  path: string,
  status: FileChangeStatus,
  hunks: DiffHunk[],
  {
    maxLines,
    approximate = false,
    oldPath = null,
    binary = false,
  }: {
    maxLines: number;
    approximate?: boolean;
    oldPath?: string | null;
    binary?: boolean;
  },
): FileDiff {
  const counts = countChanges(hunks);
  const capped = capHunks(hunks, maxLines);
  return {
    path,
    oldPath,
    status,
    binary,
    ...counts,
    hunks: capped.hunks,
    truncated: capped.truncated,
    approximate,
  };
}

/**
 * Hunks between two texts (`null`: the file did not exist), 3 lines of
 * context. `null` when the texts are too large to diff in time.
 */
export function diffTexts(
  before: string | null,
  after: string | null,
): DiffHunk[] | null {
  const oldText = before ?? '';
  const newText = after ?? '';
  if (oldText.length + newText.length > MAX_DIFF_INPUT) {
    return null;
  }
  const patch = structuredPatch(
    'a',
    'b',
    oldText,
    newText,
    undefined,
    undefined,
    {
      context: 3,
      timeout: DIFF_TIMEOUT_MS,
    },
  );
  if (!patch) {
    return null;
  }
  return patch.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines,
  }));
}
