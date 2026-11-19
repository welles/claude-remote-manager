import type { ShownFileKind } from './shown-files';

/**
 * Files of a session for `@` references in the input
 * (`GET /api/sessions/:id/files?query=&limit=`).
 */

/** A file of one of the session's directories. */
export interface FileMention {
  /** Position of the directory in the session (0: working directory). */
  directory: number;
  /** `owner/name` of the directory's repository; `null` for scratch. */
  repository: string | null;
  /** Path relative to the directory. */
  path: string;
  /**
   * What to put into the message: `@path` relative to the working
   * directory, `@/absolute/path` in other directories, quoted
   * (`@"..."`) when it contains spaces. Claude Code reads the file into
   * the conversation when the message is sent.
   */
  mention: string;
}

export interface FileMentionsResponse {
  files: FileMention[];
  /** More files matched than were returned. */
  truncated: boolean;
}

/**
 * A directory of a session for the file browser
 * (`GET /api/sessions/:id/browse`).
 */
export interface BrowsedDirectory {
  /** Position in the session (0: working directory). */
  directory: number;
  /** `owner/name` of the repository; `null` for scratch. */
  repository: string | null;
  /** Absolute path of the directory. */
  path: string;
  /** Files below it, relative (git's tracked and untracked, not ignored). */
  files: string[];
  /** More files than were listed. */
  truncated: boolean;
  /** Why the directory could not be listed (then `files` is empty). */
  error: string | null;
}

export interface BrowseResponse {
  directories: BrowsedDirectory[];
}

/**
 * A file of a session's directory as the browser shows it
 * (`GET /api/sessions/:id/browse/file?directory=&path=`); its content is
 * at `.../browse/content` with the same query.
 */
export interface BrowsedFileDto {
  directory: number;
  /** Relative to the directory. */
  path: string;
  name: string;
  kind: ShownFileKind;
  mediaType: string;
  /** Language for syntax highlighting (text), e.g. `typescript`. */
  language: string | null;
  size: number;
  /** What to put into a message to reference it (`@path`). */
  mention: string;
}
