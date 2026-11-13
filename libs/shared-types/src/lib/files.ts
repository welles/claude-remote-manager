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
