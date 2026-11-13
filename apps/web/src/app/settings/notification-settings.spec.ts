import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { words } from '../testing/text';
import { NotificationSettings, PUSH_DEVICE } from './notification-settings';
import type { DeviceEnvironment } from './push-device';
import { isIos, pushSupport } from './push-device';
import { notificationStatus } from './testing/notification-status';

const desktop: DeviceEnvironment = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0',
  maxTouchPoints: 0,
  standalone: false,
  secure: true,
  serviceWorker: true,
  pushManager: true,
  notification: true,
};
const iphone: DeviceEnvironment = {
  ...desktop,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
  maxTouchPoints: 5,
  pushManager: false,
};

describe('NotificationSettings', () => {
  let http: HttpTestingController;
  const original = { ...PUSH_DEVICE };
  let environment: DeviceEnvironment;

  beforeEach(async () => {
    environment = desktop;
    PUSH_DEVICE.environment = () => environment;
    PUSH_DEVICE.current = async () => null;
    await TestBed.configureTestingModule({
      imports: [NotificationSettings],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    Object.assign(PUSH_DEVICE, original);
    http.verify();
  });

  const render = async (status = notificationStatus()) => {
    const fixture = TestBed.createComponent(NotificationSettings);
    fixture.detectChanges();
    http.expectOne('/api/notifications').flush(status);
    await fixture.whenStable();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const find = (testId: string) =>
      element.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
    return { fixture, element, find };
  };

  it('shows ntfy read-only and sends test notifications per channel', async () => {
    const { fixture, find } = await render();
    expect(words(find('ntfy') as HTMLElement)).toBe(
      'Server https://ntfy.example.com Topic crm Access token set',
    );
    find('test-ntfy')?.click();
    const request = http.expectOne({
      method: 'POST',
      url: '/api/notifications/test',
    });
    expect(request.request.body).toEqual({ channel: 'ntfy' });
    request.flush({ ok: false, message: 'ntfy did not accept it: HTTP 401' });
    fixture.detectChanges();
    expect(words(find('test-result-ntfy') as HTMLElement)).toBe(
      'ntfy did not accept it: HTTP 401',
    );
  });

  it('switches events per channel', async () => {
    const { fixture, find } = await render();
    const checkbox = find('pref-stalled-ntfy')?.querySelector(
      'input',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    checkbox.click();
    const request = http.expectOne({
      method: 'PUT',
      url: '/api/notifications/preferences',
    });
    expect(request.request.body).toEqual({
      preferences: { stalled: { ntfy: false } },
    });
    const changed = notificationStatus();
    changed.preferences.stalled.ntfy = false;
    request.flush(changed);
    fixture.detectChanges();
    expect(checkbox.checked).toBe(false);
  });

  it('turns Web Push on for this device on a click', async () => {
    const enable = vi.fn(async () => ({
      ok: true as const,
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/x',
        keys: { p256dh: 'p', auth: 'a' },
      },
    }));
    PUSH_DEVICE.enable = enable;
    const { fixture, find } = await render();
    expect(enable).not.toHaveBeenCalled();
    find('enable-push')?.click();
    await fixture.whenStable();
    expect(enable).toHaveBeenCalledWith('BKey');
    const request = http.expectOne({
      method: 'POST',
      url: '/api/notifications/push-subscriptions',
    });
    expect(request.request.body).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: { p256dh: 'p', auth: 'a' },
    });
    request.flush({ id: 'd1' });
    await fixture.whenStable();
    http.expectOne('/api/notifications').flush(
      notificationStatus({
        webPush: {
          vapidPublicKey: 'BKey',
          problem: null,
          subscriptions: [
            {
              id: 'd1',
              label: 'Chrome on Linux',
              pushService: 'fcm.googleapis.com',
              createdAt: '2026-01-01T00:00:00.000Z',
              lastSuccessAt: null,
              lastError: null,
            },
          ],
        },
      }),
    );
    fixture.detectChanges();
    expect(find('device-on')).not.toBeNull();
    expect(words(find('device') as HTMLElement)).toContain('Chrome on Linux');
  });

  it('explains that iOS needs the installed app', async () => {
    environment = iphone;
    const { find } = await render();
    expect(find('ios-hint')).not.toBeNull();
    expect(find('enable-push')).toBeNull();
  });

  it('knows where Web Push works', () => {
    expect(pushSupport(desktop)).toEqual({ supported: true });
    expect(pushSupport(iphone)).toEqual({
      supported: false,
      reason: 'ios_not_installed',
    });
    expect(
      pushSupport({ ...iphone, standalone: true, pushManager: true }),
    ).toEqual({ supported: true });
    // iPads report a Mac user agent.
    expect(
      isIos({
        ...desktop,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        maxTouchPoints: 5,
      }),
    ).toBe(true);
    expect(pushSupport({ ...desktop, secure: false })).toEqual({
      supported: false,
      reason: 'insecure',
    });
  });
});
