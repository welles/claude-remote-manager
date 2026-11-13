import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { NotificationPreferencesStore } from './notification-preferences';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NTFY_FETCH, NtfyChannel } from './ntfy.channel';
import { PushSubscriptionRepository } from './push-subscription.repository';
import { SessionNotifier } from './session-notifier';
import {
  PushSender,
  WebPushChannel,
  WebPushLibrarySender,
} from './web-push.channel';

@Module({
  imports: [SessionsModule],
  controllers: [NotificationsController],
  providers: [
    NotificationPreferencesStore,
    PushSubscriptionRepository,
    { provide: PushSender, useClass: WebPushLibrarySender },
    WebPushChannel,
    {
      provide: NTFY_FETCH,
      useValue: (url: string, init: RequestInit) => fetch(url, init),
    },
    NtfyChannel,
    NotificationsService,
    SessionNotifier,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
