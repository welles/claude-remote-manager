import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  ReviewDefaults,
  SessionDto,
  StartReviewResponse,
  UpdateReviewDefaultsRequest,
  UpdateSessionReviewRequest,
} from '@claude-remote-manager/shared-types';

const sessionPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;

/** Independent reviews of sessions' changes and their settings. */
@Injectable({ providedIn: 'root' })
export class ReviewsApi {
  private readonly http = inject(HttpClient);

  defaults(): Observable<ReviewDefaults> {
    return this.http.get<ReviewDefaults>('/api/settings/review');
  }

  updateDefaults(
    request: UpdateReviewDefaultsRequest,
  ): Observable<ReviewDefaults> {
    return this.http.put<ReviewDefaults>('/api/settings/review', request);
  }

  start(sessionId: string): Observable<StartReviewResponse> {
    return this.http.post<StartReviewResponse>(
      `${sessionPath(sessionId)}/review`,
      {},
    );
  }

  cancel(sessionId: string): Observable<void> {
    return this.http.delete<void>(`${sessionPath(sessionId)}/review`);
  }

  updateSession(
    sessionId: string,
    request: UpdateSessionReviewRequest,
  ): Observable<SessionDto> {
    return this.http.put<SessionDto>(
      `${sessionPath(sessionId)}/review-settings`,
      request,
    );
  }
}
