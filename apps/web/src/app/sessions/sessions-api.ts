import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  AddSessionRepositoryRequest,
  BrowseResponse,
  BrowsedFileDto,
  CleanupChoice,
  CleanupPreview,
  CleanupResult,
  CloneLossReport,
  DeletionPreview,
  SearchResponse,
  CreatePullRequestRequest,
  CreateSessionRequest,
  FileMentionsResponse,
  PullRequestDto,
  SessionDiffFile,
  SessionDiffResponse,
  SessionDto,
  SessionListResponse,
  SlashCommandsResponse,
  UpdatePullRequestAutomationRequest,
} from '@claude-remote-manager/shared-types';

const sessionPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;

/** Where a browsed file's content is served. */
export function browsedContentUrl(
  sessionId: string,
  directory: number,
  path: string,
  { download = false }: { download?: boolean } = {},
): string {
  const query = new URLSearchParams({ directory: String(directory), path });
  if (download) {
    query.set('download', '1');
  }
  return `${sessionPath(sessionId)}/browse/content?${query}`;
}

/** REST client for sessions. */
@Injectable({ providedIn: 'root' })
export class SessionsApi {
  private readonly http = inject(HttpClient);

  /** Sessions that are not archived, or with `archived` only the archived ones. */
  list(archived = false): Observable<SessionListResponse> {
    return this.http.get<SessionListResponse>(
      '/api/sessions',
      archived ? { params: { archived: 'only' } } : {},
    );
  }

  /** Renames a session (only the title changes). */
  rename(sessionId: string, title: string): Observable<SessionDto> {
    return this.http.patch<SessionDto>(sessionPath(sessionId), { title });
  }

  /** What cleaning up the session's directories would do and lose. */
  cleanupPreview(sessionId: string): Observable<CleanupPreview> {
    return this.http.get<CleanupPreview>(`${sessionPath(sessionId)}/cleanup`);
  }

  cleanup(
    sessionId: string,
    choices: CleanupChoice[],
  ): Observable<CleanupResult> {
    return this.http.post<CleanupResult>(`${sessionPath(sessionId)}/cleanup`, {
      directories: choices,
    });
  }

  archive(
    sessionId: string,
    choices: CleanupChoice[],
  ): Observable<CleanupResult> {
    return this.http.post<CleanupResult>(`${sessionPath(sessionId)}/archive`, {
      cleanup: choices,
    });
  }

  unarchive(sessionId: string): Observable<SessionDto> {
    return this.http.post<SessionDto>(
      `${sessionPath(sessionId)}/unarchive`,
      {},
    );
  }

  /** What deleting the session removes. */
  deletionPreview(sessionId: string): Observable<DeletionPreview> {
    return this.http.get<DeletionPreview>(`${sessionPath(sessionId)}/deletion`);
  }

  delete(sessionId: string, acceptLoss: boolean): Observable<void> {
    return this.http.post<void>(`${sessionPath(sessionId)}/delete`, {
      confirm: true,
      acceptLoss,
    });
  }

  /** Full-text search over sessions and their conversations. */
  search(query: string): Observable<SearchResponse> {
    return this.http.get<SearchResponse>('/api/search', {
      params: { q: query },
    });
  }

  get(id: string): Observable<SessionDto> {
    return this.http.get<SessionDto>(`/api/sessions/${encodeURIComponent(id)}`);
  }

  create(request: CreateSessionRequest): Observable<SessionDto> {
    return this.http.post<SessionDto>('/api/sessions', request);
  }

  /** Pushes the session branch of one repository's clone. */
  push(sessionId: string, repositoryId: string): Observable<SessionDto> {
    return this.http.post<SessionDto>(
      `${sessionPath(sessionId)}/repositories/${encodeURIComponent(repositoryId)}/push`,
      {},
    );
  }

  createPullRequest(
    sessionId: string,
    repositoryId: string,
    request: CreatePullRequestRequest,
  ): Observable<PullRequestDto> {
    return this.http.post<PullRequestDto>(
      `${sessionPath(sessionId)}/repositories/${encodeURIComponent(repositoryId)}/pull-requests`,
      request,
    );
  }

  /** Files of the session's directories matching a query (`@`). */
  files(sessionId: string, query: string): Observable<FileMentionsResponse> {
    return this.http.get<FileMentionsResponse>(
      `${sessionPath(sessionId)}/files`,
      { params: { query } },
    );
  }

  /** The session's directories with their files (file browser). */
  browse(sessionId: string): Observable<BrowseResponse> {
    return this.http.get<BrowseResponse>(`${sessionPath(sessionId)}/browse`);
  }

  /** What kind of file it is. */
  browsedFile(
    sessionId: string,
    directory: number,
    path: string,
  ): Observable<BrowsedFileDto> {
    return this.http.get<BrowsedFileDto>(
      `${sessionPath(sessionId)}/browse/file`,
      {
        params: { directory, path },
      },
    );
  }

  /** Slash commands and skills for `/` autocomplete. */
  slashCommands(sessionId: string): Observable<SlashCommandsResponse> {
    return this.http.get<SlashCommandsResponse>(
      `${sessionPath(sessionId)}/slash-commands`,
    );
  }

  /** What the session changed, per repository and file. */
  diff(sessionId: string): Observable<SessionDiffResponse> {
    return this.http.get<SessionDiffResponse>(`${sessionPath(sessionId)}/diff`);
  }

  /** One file of the session's diff, with the larger single-file limit. */
  fileDiff(
    sessionId: string,
    repositoryId: string,
    path: string,
    oldPath: string | null,
  ): Observable<SessionDiffFile> {
    return this.http.get<SessionDiffFile>(
      `${sessionPath(sessionId)}/diff/file`,
      {
        params: { repositoryId, path, ...(oldPath ? { oldPath } : {}) },
      },
    );
  }

  refreshPullRequests(sessionId: string): Observable<SessionDto> {
    return this.http.post<SessionDto>(
      `${sessionPath(sessionId)}/pull-requests/refresh`,
      {},
    );
  }

  /** Autofix and autoclose of a pull request, its limit, a reset. */
  updateAutomation(
    sessionId: string,
    pullRequestId: number,
    request: UpdatePullRequestAutomationRequest,
  ): Observable<SessionDto> {
    return this.http.patch<SessionDto>(
      `${sessionPath(sessionId)}/pull-requests/${pullRequestId}/automation`,
      request,
    );
  }

  /** Stops the running autofix run (and turns autofix off for its PR). */
  stopAutofix(sessionId: string): Observable<SessionDto> {
    return this.http.post<SessionDto>(
      `${sessionPath(sessionId)}/autofix/stop`,
      {},
    );
  }

  /** What deleting a clone of the session would lose. */
  cloneLoss(
    sessionId: string,
    repositoryId: string,
  ): Observable<CloneLossReport> {
    return this.http.get<CloneLossReport>(
      `${sessionPath(sessionId)}/repositories/${encodeURIComponent(repositoryId)}/clone-loss`,
    );
  }

  /** Adds a registered repository to the session (prepared in the background). */
  addRepository(
    sessionId: string,
    request: AddSessionRepositoryRequest,
  ): Observable<SessionDto> {
    return this.http.post<SessionDto>(
      `${sessionPath(sessionId)}/repositories`,
      request,
    );
  }

  /**
   * For a repository whose addition failed or is held: `retry` (clone or
   * run the setup again), `accept` (use it although its setup failed) or
   * `remove` (forget it and its clone).
   */
  additionAction(
    sessionId: string,
    repositoryId: string,
    action: 'retry' | 'accept' | 'remove',
  ): Observable<SessionDto> {
    return this.http.post<SessionDto>(
      `${sessionPath(sessionId)}/repositories/${encodeURIComponent(repositoryId)}/addition/${action}`,
      {},
    );
  }

  /** Deletes a kept clone of an ended session (confirmed by the user). */
  discardClone(
    sessionId: string,
    repositoryId: string,
  ): Observable<SessionDto> {
    return this.http.post<SessionDto>(
      `${sessionPath(sessionId)}/repositories/${encodeURIComponent(repositoryId)}/discard-clone`,
      { confirm: true },
    );
  }
}

/** A random UUID, also outside secure contexts (plain HTTP on the LAN). */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}
