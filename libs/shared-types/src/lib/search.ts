import type { SessionStatus } from './session';
import type { AgentEngineId } from './engines';

/**
 * Full-text search over sessions (`GET /api/search?q=`): titles,
 * repositories and branches, and the conversation (the owner's messages and
 * the agent's answers), archived sessions included. The query is plain text:
 * whitespace separates words, every word must occur (as a substring, any
 * case); there is no query syntax.
 */

/** Where a match was found. */
export type SearchMatchKind =
  | 'title'
  | 'repository'
  | 'branch'
  | 'user'
  | 'assistant';

export interface SearchMatch {
  kind: SearchMatchKind;
  /** The matching text, shortened around the first match. */
  snippet: string;
  /** `[start, end)` ranges of the query's words in `snippet`. */
  highlights: [number, number][];
  /**
   * For conversation matches: the ID of the user message or of the agent's
   * message, to show that place in the history.
   */
  anchor: string | null;
}

export interface SearchHit {
  sessionId: string;
  title: string | null;
  status: SessionStatus;
  archivedAt: string | null;
  updatedAt: string;
  /**
   * The agent engine the session runs with (names the agent of `assistant`
   * matches). Absent from older servers.
   */
  engine?: AgentEngineId;
  /** `owner/name` of the session's repositories. */
  repositories: string[];
  /** The first matches (at most 3). */
  matches: SearchMatch[];
  /** All matches found in the session (up to the search's limits). */
  matchCount: number;
}

/** Response of `GET /api/search`. */
export interface SearchResponse {
  query: string;
  /** Sessions with matches: metadata matches first, then newest first. */
  hits: SearchHit[];
  /** More matched than shown; refine the query. */
  truncated: boolean;
}

/** Longest query accepted, in characters. */
export const SEARCH_QUERY_MAX_LENGTH = 200;
