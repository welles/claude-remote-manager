/**
 * Files put in front of the user: by Claude with the tool `show_file`, or
 * images Claude read or wrote. The content at that moment is kept as a
 * snapshot by the server (up to {@link MAX_SNAPSHOT_BYTES}), so the
 * history shows it even after the file changed or the session was cleaned
 * up. Served at `GET /api/shown-files/:id/content` (`?download=1` to save
 * it); larger files only while they exist, at `.../live`.
 */

/** How the viewer shows a file. */
export type ShownFileKind =
  | 'image'
  | 'markdown'
  | 'html'
  | 'pdf'
  | 'text'
  | 'binary';

/** Why the file was shown. */
export type ShownFileOrigin = 'show_file' | 'read' | 'write';

/** Snapshots are kept up to this size. */
export const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;

export interface ShownFileDto {
  id: string;
  origin: ShownFileOrigin;
  /** Absolute path (symlinks resolved). */
  path: string;
  /** File name. */
  name: string;
  caption: string | null;
  kind: ShownFileKind;
  /** Media type it is served with. */
  mediaType: string;
  /** Language for syntax highlighting (text), e.g. `typescript`. */
  language: string | null;
  size: number;
  /**
   * The content was kept. Without (larger than the limit), only the live
   * file can be opened, while it exists.
   */
  snapshot: boolean;
  createdAt: string;
}
