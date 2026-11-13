import type { RegisterPushSubscriptionRequest } from '@claude-remote-manager/shared-types';

/**
 * Web Push on this device: whether it can work here, and subscribing and
 * unsubscribing with the browser's push service.
 */

export type PushSupport =
  | { supported: true }
  | {
      supported: false;
      /**
       * - `ios_not_installed`: iPhone/iPad in the browser; Web Push works
       *   only in the app added to the Home Screen;
       * - `insecure`: not https (nor localhost);
       * - `unsupported`: no service worker or Push API.
       */
      reason: 'ios_not_installed' | 'insecure' | 'unsupported';
    };

export interface DeviceEnvironment {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  secure: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
}

export function currentEnvironment(): DeviceEnvironment {
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone:
      matchMedia?.('(display-mode: standalone)').matches === true ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
    secure: globalThis.isSecureContext === true,
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in globalThis,
    notification: 'Notification' in globalThis,
  };
}

/** iPhone, iPad (also when it claims to be a Mac). */
export function isIos(environment: DeviceEnvironment): boolean {
  return (
    /iPhone|iPad|iPod/.test(environment.userAgent) ||
    (/Macintosh/.test(environment.userAgent) && environment.maxTouchPoints > 1)
  );
}

export function pushSupport(environment: DeviceEnvironment): PushSupport {
  if (isIos(environment) && !environment.standalone) {
    return { supported: false, reason: 'ios_not_installed' };
  }
  if (!environment.secure) {
    return { supported: false, reason: 'insecure' };
  }
  if (
    !environment.serviceWorker ||
    !environment.pushManager ||
    !environment.notification
  ) {
    return { supported: false, reason: 'unsupported' };
  }
  return { supported: true };
}

/** The subscription of this browser, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) {
    return null;
  }
  const registration = await navigator.serviceWorker.getRegistration('/');
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/**
 * Asks for the permission (call only from a click: iOS and other browsers
 * allow the prompt only on a user gesture) and subscribes this browser with
 * the server's VAPID key. Returns what to register with the API, or why not.
 */
export async function enablePush(
  vapidPublicKey: string,
): Promise<
  | { ok: true; subscription: RegisterPushSubscriptionRequest }
  | { ok: false; message: string }
> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return {
      ok: false,
      message:
        permission === 'denied'
          ? 'Notifications are blocked for this site. Allow them in the browser or system settings, then try again.'
          : 'Notifications were not allowed.',
    };
  }
  const registration = await navigator.serviceWorker.ready;
  const key = Uint8Array.from(
    atob(vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/')),
    (char) => char.charCodeAt(0),
  );
  let subscription = await registration.pushManager.getSubscription();
  const current = subscription?.options.applicationServerKey;
  if (subscription && current && !sameKey(current, key)) {
    // Subscribed with another server key (keys changed): start over.
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.['p256dh'] || !json.keys?.['auth']) {
    return {
      ok: false,
      message: 'The browser returned no usable subscription.',
    };
  }
  return {
    ok: true,
    subscription: {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys['p256dh'], auth: json.keys['auth'] },
    },
  };
}

function sameKey(a: ArrayBuffer, b: Uint8Array): boolean {
  const left = new Uint8Array(a);
  return left.length === b.length && left.every((byte, i) => byte === b[i]);
}
