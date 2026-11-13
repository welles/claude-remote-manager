import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  GitHubReferenceDetail,
  GitHubReferenceSearchResponse,
  MessageContextResponse,
} from '@claude-remote-manager/shared-types';

/** REST client for `#` references to GitHub issues and pull requests. */
@Injectable({ providedIn: 'root' })
export class ReferencesApi {
  private readonly http = inject(HttpClient);

  /** Issues and pull requests matching what was typed after `#`. */
  search(
    query: string,
    repositories: string[],
  ): Observable<GitHubReferenceSearchResponse> {
    return this.http.get<GitHubReferenceSearchResponse>(
      '/api/github/references',
      { params: { query, repositories: repositories.join(',') } },
    );
  }

  /** One issue or pull request for a chip's preview. */
  detail(
    repository: string,
    number: number,
  ): Observable<GitHubReferenceDetail> {
    const [owner, name] = repository.split('/');
    return this.http.get<GitHubReferenceDetail>(
      `/api/github/references/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${number}`,
    );
  }

  /** The context Claude got with a message. */
  messageContext(
    sessionId: string,
    messageId: string,
  ): Observable<MessageContextResponse> {
    return this.http.get<MessageContextResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/context`,
    );
  }
}
