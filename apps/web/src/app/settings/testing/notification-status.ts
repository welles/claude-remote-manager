import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationPreferences,
  type NotificationStatusDto,
} from '@claude-remote-manager/shared-types';

/** A notification status as the API returns it, everything on. */
export function notificationStatus(
  overrides: Partial<NotificationStatusDto> = {},
): NotificationStatusDto {
  const preferences = {} as NotificationPreferences;
  for (const type of NOTIFICATION_EVENT_TYPES) {
    preferences[type] = { webPush: true, ntfy: true };
  }
  return {
    preferences,
    stallMinutes: 15,
    publicUrl: 'https://crm.example.com',
    webPush: {
      vapidPublicKey: 'BKey',
      problem: null,
      subscriptions: [],
    },
    ntfy: {
      configured: true,
      server: 'https://ntfy.example.com',
      topic: 'crm',
      tokenSet: true,
      problem: null,
    },
    ...overrides,
  };
}
