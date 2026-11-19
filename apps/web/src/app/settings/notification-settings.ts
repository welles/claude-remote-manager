import { AppDatePipe } from '../ui/dates';
import {
  Component,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_INFO,
  NOTIFICATION_EVENT_TYPES,
  type NotificationChannel,
  type NotificationEventType,
  type NotificationStatusDto,
} from '@claude-remote-manager/shared-types';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../repositories/repositories-api';
import { NotificationsApi } from './notifications-api';
import {
  currentEnvironment,
  currentSubscription,
  enablePush,
  pushSupport,
  type PushSupport,
} from './push-device';
import { Toasts } from '../ui/toasts';

/** Seam for tests: the browser's push functions. */
export const PUSH_DEVICE = {
  environment: currentEnvironment,
  current: currentSubscription,
  enable: enablePush,
};

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  webPush: 'Web Push',
  ntfy: 'ntfy',
};

/**
 * Notifications on the Settings page: Web Push on this device (iOS only
 * in the installed app; the permission is asked on a click), the devices
 * that receive it, the ntfy configuration (read-only, from the server's
 * environment), the events per channel, and test notifications.
 */
@Component({
  selector: 'app-notification-settings',
  imports: [
    AppDatePipe,
    MatButtonModule,
    MatCheckboxModule,
    MatProgressBarModule,
  ],
  templateUrl: './notification-settings.html',
  styleUrl: './notification-settings.scss',
})
export class NotificationSettings implements OnInit {
  private readonly api = inject(NotificationsApi);
  private readonly toasts = inject(Toasts);

  protected readonly eventTypes = NOTIFICATION_EVENT_TYPES;
  protected readonly eventInfo = NOTIFICATION_EVENT_INFO;
  protected readonly channels = NOTIFICATION_CHANNELS;
  protected readonly channelLabels = CHANNEL_LABELS;

  protected readonly status = signal<NotificationStatusDto | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly support = signal<PushSupport>({ supported: true });
  /** Why Web Push cannot work in this browser, `null` if it can. */
  protected readonly unsupported = computed(() => {
    const support = this.support();
    return support.supported ? null : support.reason;
  });
  /** Endpoint of this browser's subscription, if subscribed. */
  protected readonly endpoint = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly deviceMessage = signal<{
    text: string;
    error: boolean;
  } | null>(null);
  protected readonly testResults = signal<
    Partial<Record<NotificationChannel, { ok: boolean; message: string }>>
  >({});

  ngOnInit(): void {
    this.support.set(pushSupport(PUSH_DEVICE.environment()));
    this.load();
    void PUSH_DEVICE.current()
      .then((subscription) => this.endpoint.set(subscription?.endpoint ?? null))
      .catch(() => undefined);
  }

  protected load(): void {
    this.loadError.set(null);
    this.api.status().subscribe({
      next: (status) => this.status.set(status),
      error: (error: unknown) =>
        this.loadError.set(
          errorMessage(error, 'The notification settings could not be loaded.'),
        ),
    });
  }

  /** Asks for the permission and subscribes; only from a click. */
  protected async enable(): Promise<void> {
    const key = this.status()?.webPush.vapidPublicKey;
    if (!key) {
      return;
    }
    this.busy.set(true);
    this.deviceMessage.set(null);
    try {
      const result = await PUSH_DEVICE.enable(key);
      if (!result.ok) {
        this.deviceMessage.set({ text: result.message, error: true });
        return;
      }
      await firstValueFrom(this.api.subscribe(result.subscription));
      this.endpoint.set(result.subscription.endpoint);
      this.deviceMessage.set({
        text: 'Notifications are on for this device.',
        error: false,
      });
      this.load();
    } catch (error) {
      this.deviceMessage.set({
        text: errorMessage(
          error,
          'Notifications could not be turned on for this device.',
        ),
        error: true,
      });
    } finally {
      this.busy.set(false);
    }
  }

  protected async disable(): Promise<void> {
    this.busy.set(true);
    this.deviceMessage.set(null);
    try {
      const subscription = await PUSH_DEVICE.current();
      if (subscription) {
        await firstValueFrom(this.api.unsubscribe(subscription.endpoint));
        await subscription.unsubscribe();
      }
      this.endpoint.set(null);
      this.deviceMessage.set({
        text: 'Notifications are off for this device.',
        error: false,
      });
      this.load();
    } catch (error) {
      this.deviceMessage.set({
        text: errorMessage(error, 'Notifications could not be turned off.'),
        error: true,
      });
    } finally {
      this.busy.set(false);
    }
  }

  protected removeDevice(device: { id: string; label: string }): void {
    this.api.removeDevice(device.id).subscribe({
      next: () => {
        this.toasts.show({ title: 'Device removed', lines: [device.label] });
        this.load();
      },
      error: (error: unknown) =>
        this.deviceMessage.set({
          text: errorMessage(error, 'The device could not be removed.'),
          error: true,
        }),
    });
  }

  protected toggle(
    type: NotificationEventType,
    channel: NotificationChannel,
    on: boolean,
  ): void {
    this.api
      .updatePreferences({ preferences: { [type]: { [channel]: on } } })
      .subscribe({
        next: (status) => this.status.set(status),
        error: () => this.load(),
      });
  }

  protected test(channel: NotificationChannel): void {
    this.testResults.update((results) => ({
      ...results,
      [channel]: undefined,
    }));
    this.api.test(channel).subscribe({
      next: (result) =>
        this.testResults.update((results) => ({
          ...results,
          [channel]: result,
        })),
      error: (error: unknown) =>
        this.testResults.update((results) => ({
          ...results,
          [channel]: {
            ok: false,
            message: errorMessage(error, 'The test could not be sent.'),
          },
        })),
    });
  }
}
