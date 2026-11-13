import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  AppSettingsDto,
  UpdateSettingsRequest,
} from '@claude-remote-manager/shared-types';

@Injectable({ providedIn: 'root' })
export class SettingsApi {
  private readonly http = inject(HttpClient);

  get(): Observable<AppSettingsDto> {
    return this.http.get<AppSettingsDto>('/api/settings');
  }

  update(request: UpdateSettingsRequest): Observable<AppSettingsDto> {
    return this.http.put<AppSettingsDto>('/api/settings', request);
  }
}
