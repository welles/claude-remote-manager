import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  GitHubRepositoryListResponse,
  GitHubStatusDto,
} from '@claude-remote-manager/shared-types';

/** REST client for the GitHub App's status and repositories. */
@Injectable({ providedIn: 'root' })
export class GitHubApi {
  private readonly http = inject(HttpClient);

  /** `refresh` reads GitHub again instead of the server's short cache. */
  status(refresh = false): Observable<GitHubStatusDto> {
    return this.http.get<GitHubStatusDto>('/api/github/status', {
      params: refresh ? new HttpParams().set('refresh', '1') : undefined,
    });
  }

  repositories(
    query: string,
    options: { page?: number; perPage?: number; refresh?: boolean } = {},
  ): Observable<GitHubRepositoryListResponse> {
    let params = new HttpParams().set('query', query);
    if (options.page) {
      params = params.set('page', options.page);
    }
    if (options.perPage) {
      params = params.set('perPage', options.perPage);
    }
    if (options.refresh) {
      params = params.set('refresh', 'true');
    }
    return this.http.get<GitHubRepositoryListResponse>(
      '/api/github/repositories',
      { params },
    );
  }
}
