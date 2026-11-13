import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  ConnectGitHubRequest,
  CreateRepositoryRequest,
  RepositoryBranchesResponse,
  RepositoryDto,
  RepositoryListResponse,
} from '@claude-remote-manager/shared-types';

const path = (id: string) => `/api/repositories/${encodeURIComponent(id)}`;

/** REST client for repositories. */
@Injectable({ providedIn: 'root' })
export class RepositoriesApi {
  private readonly http = inject(HttpClient);

  list(): Observable<RepositoryListResponse> {
    return this.http.get<RepositoryListResponse>('/api/repositories');
  }

  create(request: CreateRepositoryRequest): Observable<RepositoryDto> {
    return this.http.post<RepositoryDto>('/api/repositories', request);
  }

  updateSetupScript(
    id: string,
    setupScript: string | null,
  ): Observable<RepositoryDto> {
    return this.http.patch<RepositoryDto>(path(id), { setupScript });
  }

  fetch(id: string): Observable<RepositoryDto> {
    return this.http.post<RepositoryDto>(`${path(id)}/fetch`, {});
  }

  /** Registers a GitHub repository (idempotent) and starts cloning it. */
  registerGitHub(githubRepositoryId: number): Observable<RepositoryDto> {
    return this.http.post<RepositoryDto>('/api/repositories', {
      githubRepositoryId,
    });
  }

  /** Gives a local project a GitHub repository as remote. */
  connectGitHub(
    id: string,
    request: ConnectGitHubRequest,
  ): Observable<RepositoryDto> {
    return this.http.post<RepositoryDto>(`${path(id)}/github`, request);
  }

  branches(id: string): Observable<RepositoryBranchesResponse> {
    return this.http.get<RepositoryBranchesResponse>(`${path(id)}/branches`);
  }
}

/** Error text of a failed request, e.g. the API's validation message. */
export function errorMessage(error: unknown, fallback: string): string {
  const body = (error as { error?: { message?: unknown } } | null)?.error;
  const message = body?.message;
  return typeof message === 'string'
    ? message
    : Array.isArray(message)
      ? message.join(', ')
      : fallback;
}
