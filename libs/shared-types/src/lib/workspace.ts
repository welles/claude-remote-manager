import type { DirectoryLoss } from './session-management';

/**
 * Leftovers in the workspace: directories under `sessions/` and `scratch/`
 * that no session uses, and directories sessions expect that are gone.
 * `GET /api/workspace/orphans`.
 */

/** A directory no session uses. */
export interface OrphanedDirectory {
  path: string;
  /**
   * `clone`: `sessions/<slug>/<owner>/<name>`; `scratch`:
   * `scratch/<slug>`; `directory`: another directory under `sessions/`
   * (e.g. an empty or unexpected one).
   */
  kind: 'clone' | 'scratch' | 'directory';
  /** Branch checked out in a clone, when known. */
  branch: string | null;
  /** What removing it loses; `null` if that could not be read. */
  loss: DirectoryLoss | null;
  /** Why `loss` is unknown. */
  error: string | null;
}

/** A directory a session expects that is not there any more. */
export interface MissingDirectory {
  sessionId: string;
  sessionTitle: string | null;
  position: number;
  path: string;
  /** `owner/name`, or `Scratch`. */
  name: string;
}

export interface WorkspaceOrphansResponse {
  orphans: OrphanedDirectory[];
  missing: MissingDirectory[];
}

/** Body of `POST /api/workspace/orphans/remove`. */
export interface RemoveOrphanRequest {
  path: string;
  /** Must be `true`: the owner confirmed. */
  confirm: boolean;
  /** Needed when it holds work that would be lost. */
  acceptLoss?: boolean;
}

/**
 * Body of `POST /api/workspace/missing/forget`: marks a session's directory
 * that is gone as removed (the session then shows it cannot continue).
 */
export interface ForgetMissingRequest {
  sessionId: string;
  position: number;
}
