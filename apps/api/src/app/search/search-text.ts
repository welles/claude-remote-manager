import {
  SEARCH_QUERY_MAX_LENGTH,
  type SearchMatch,
  type SearchMatchKind,
} from '@claude-remote-manager/shared-types';

/** Most words a query may have; further ones are ignored. */
export const MAX_TERMS = 8;
/** Characters of context before the first match in a snippet. */
const SNIPPET_BEFORE = 60;
/** Length of a snippet. */
const SNIPPET_LENGTH = 220;

/**
 * Text folded for comparison: Unicode compatibility form, lower case
 * (`Größe` and `GRÖSSE`… stay apart, `Ä` and `ä` do not), so the index and
 * the query compare the same way. `map[i]` is the offset in the original
 * text of folded character `i`.
 */
export function fold(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let offset = 0;
  for (const char of text) {
    const part = char.normalize('NFKC').toLowerCase();
    folded += part;
    for (let index = 0; index < part.length; index++) {
      map.push(offset);
    }
    offset += char.length;
  }
  map.push(offset);
  return { folded, map };
}

export const foldText = (text: string): string => fold(text).folded;

/**
 * The words of a query, folded: split at whitespace, empty words dropped,
 * duplicates removed, at most {@link MAX_TERMS}. Nothing in the query has
 * a special meaning.
 */
export function queryTerms(query: string): string[] {
  const terms = foldText(query.slice(0, SEARCH_QUERY_MAX_LENGTH))
    .split(/\s+/u)
    .filter(Boolean);
  return [...new Set(terms)].slice(0, MAX_TERMS);
}

/** A `LIKE` pattern that matches the term anywhere (`\` escapes). */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Whether every term occurs in the text. */
export function matchesAll(text: string, terms: string[]): boolean {
  const { folded } = fold(text);
  return terms.every((term) => folded.includes(term));
}

/**
 * A match: the text shortened around the first occurrence of a term, with
 * the ranges of all terms in it.
 */
export function snippet(
  kind: SearchMatchKind,
  text: string,
  terms: string[],
  anchor: string | null = null,
): SearchMatch {
  const { folded, map } = fold(text);
  const ranges: [number, number][] = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const index = folded.indexOf(term, from);
      if (index < 0 || term.length === 0) {
        break;
      }
      ranges.push([map[index], map[index + term.length]]);
      from = index + term.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const first = ranges[0]?.[0] ?? 0;
  let start = Math.max(0, first - SNIPPET_BEFORE);
  // Start at a word boundary when one is close.
  const space = text.lastIndexOf(' ', first);
  if (start > 0 && space >= start && space - start < 20) {
    start = space + 1;
  }
  const end = Math.min(text.length, start + SNIPPET_LENGTH);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const body = text.slice(start, end).replace(/\s/g, ' ');
  const highlights: [number, number][] = [];
  for (const [from, to] of ranges) {
    if (from >= start && to <= end) {
      const shifted: [number, number] = [
        from - start + prefix.length,
        to - start + prefix.length,
      ];
      const last = highlights.at(-1);
      if (last && shifted[0] < last[1]) {
        last[1] = Math.max(last[1], shifted[1]);
      } else {
        highlights.push(shifted);
      }
    }
  }
  return { kind, snippet: `${prefix}${body}${suffix}`, highlights, anchor };
}
