import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  CloneLossReport,
  CreatePullRequestRequest,
  CreateSessionRequest,
  FileMentionsResponse,
  PullRequestDto,
  SessionDiffFile,
  SessionDiffResponse,
  SessionDto,
  SessionListResponse,
  UpdatePullRequestAutomationRequest,
} from '@claude-remote-manager/shared-types';

const sessionPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;

/** REST client for sessions. */
@Injectable({ providedIn: 'root' })
export class SessionsApi {
  private readonly http = inject(HttpClient);

  list(): Observable<SessionListResponse> {
    return this.http.get<SessionListResponse>('/api/sessions');
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
