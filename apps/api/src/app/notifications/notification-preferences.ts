import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_TYPES,
  type NotificationChannel,
  type NotificationEventType,
  type NotificationPreferences,
  type UpdateNotificationPreferencesRequest,
} from '@claude-remote-manager/shared-types';
import { requireObject } from '../common/validation';
import { DATABASE, type AppDatabase } from '../db/database';
import { appSettings } from '../db/schema';

/** Key of the preferences in `app_settings`. */
export const PREFERENCES_KEY = 'notifications';

/** Everything on: a channel only sends once it is set up. */
export function defaultPreferences(): NotificationPreferences {
  const preferences = {} as NotificationPreferences;
  for (const type of NOTIFICATION_EVENT_TYPES) {
    preferences[type] = { webPush: true, ntfy: true };
  }
  return preferences;
}

/** Which events go to which channel, stored in `app_settings`. */
@Injectable()
export class NotificationPreferencesStore {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  get(): NotificationPreferences {
    const preferences = defaultPreferences();
    const row = this.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, PREFERENCES_KEY))
      .get();
    const stored = row?.value as Record<string, unknown> | undefined;
    for (const type of NOTIFICATION_EVENT_TYPES) {
      const entry = stored?.[type] as Record<string, unknown> | undefined;
      for (const channel of NOTIFICATION_CHANNELS) {
        if (typeof entry?.[channel] === 'boolean') {
          preferences[type][channel] = entry[channel] as boolean;
        }
      }
    }
    return preferences;
  }

  enabled(type: NotificationEventType, channel: NotificationChannel): boolean {
    return this.get()[type][channel];
  }

  update(
    request: UpdateNotificationPreferencesRequest,
    now = new Date(),
  ): NotificationPreferences {
    const body = requireObject(request);
    const changes = requireObject(body['preferences'], 'preferences');
    const preferences = this.get();
    for (const [type, value] of Object.entries(changes)) {
      if (!(NOTIFICATION_EVENT_TYPES as string[]).includes(type)) {
        throw new BadRequestException(`Unknown notification event: ${type}`);
      }
      const channels = requireObject(value, `preferences.${type}`);
      for (const [channel, on] of Object.entries(channels)) {
        if (!(NOTIFICATION_CHANNELS as string[]).includes(channel)) {
          throw new BadRequestException(`Unknown channel: ${channel}`);
        }
        if (typeof on !== 'boolean') {
          throw new BadRequestException(
            `preferences.${type}.${channel} must be a boolean`,
          );
        }
        preferences[type as NotificationEventType][
          channel as NotificationChannel
        ] = on;
      }
    }
    this.db
      .insert(appSettings)
      .values({ key: PREFERENCES_KEY, value: preferences, updatedAt: now })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: preferences, updatedAt: now },
      })
      .run();
    return preferences;
  }
}
