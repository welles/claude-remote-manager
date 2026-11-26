/**
 * Query parameters of the changes page (`/sessions/:id/changes`) that show
 * one commit of a session clone instead of all changes.
 */
export interface CommitQuery {
  repository: string;
  branch: string;
  commit: string;
}

export function commitQuery(
  repositoryId: string,
  branch: string | null,
  sha: string,
): Partial<CommitQuery> {
  return {
    repository: repositoryId,
    ...(branch ? { branch } : {}),
    commit: sha,
  };
}
