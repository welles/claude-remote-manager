import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  NotificationChannel,
  NotificationStatusDto,
  PushSubscriptionDto,
  RegisterPushSubscriptionRequest,
  TestNotificationResult,
  UpdateNotificationPreferencesRequest,
} from '@claude-remote-manager/shared-types';

/** REST client for the notification settings and devices. */
@Injectable({ providedIn: 'root' })
export class NotificationsApi {
  private readonly http = inject(HttpClient);

  status(): Observable<NotificationStatusDto> {
    return this.http.get<NotificationStatusDto>('/api/notifications');
  }

  updatePreferences(
    request: UpdateNotificationPreferencesRequest,
  ): Observable<NotificationStatusDto> {
    return this.http.put<NotificationStatusDto>(
      '/api/notifications/preferences',
      request,
    );
  }

  subscribe(
    subscription: RegisterPushSubscriptionRequest,
  ): Observable<PushSubscriptionDto> {
    return this.http.post<PushSubscriptionDto>(
      '/api/notifications/push-subscriptions',
      subscription,
    );
  }

  unsubscribe(endpoint: string): Observable<void> {
    return this.http.post<void>(
      '/api/notifications/push-subscriptions/remove',
      { endpoint },
    );
  }

  removeDevice(id: string): Observable<void> {
    return this.http.delete<void>(
      `/api/notifications/push-subscriptions/${encodeURIComponent(id)}`,
    );
  }

  test(channel: NotificationChannel): Observable<TestNotificationResult> {
    return this.http.post<TestNotificationResult>('/api/notifications/test', {
      channel,
    });
  }
}
