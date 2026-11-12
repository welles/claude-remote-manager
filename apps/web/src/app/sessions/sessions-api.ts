import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  CreateSessionRequest,
  SessionDto,
  SessionListResponse,
} from '@claude-remote-manager/shared-types';

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
