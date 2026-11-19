import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  EnvironmentDto,
  EnvironmentListResponse,
  SaveEnvironmentRequest,
} from '@claude-remote-manager/shared-types';

const path = (id: string) => `/api/environments/${encodeURIComponent(id)}`;

/** REST client for environments. */
@Injectable({ providedIn: 'root' })
export class EnvironmentsApi {
  private readonly http = inject(HttpClient);

  list(): Observable<EnvironmentListResponse> {
    return this.http.get<EnvironmentListResponse>('/api/environments');
  }

  get(id: string): Observable<EnvironmentDto> {
    return this.http.get<EnvironmentDto>(path(id));
  }

  create(request: SaveEnvironmentRequest): Observable<EnvironmentDto> {
    return this.http.post<EnvironmentDto>('/api/environments', request);
  }

  update(
    id: string,
    request: SaveEnvironmentRequest,
  ): Observable<EnvironmentDto> {
    return this.http.put<EnvironmentDto>(path(id), request);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(path(id));
  }
}
