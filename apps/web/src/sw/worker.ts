/// <reference lib="webworker" />
/**
 * Service worker of the web app (built into `/sw.js` by
 * scripts/build-service-worker.mjs): offline shell, Web Push notifications
 * with Allow/Deny actions, the app icon's badge, and the share target.
 * The logic lives in the modules next to it; this file wires the events.
 */
import type {
  ApprovalAction,
  PushPayload,
} from '@claude-remote-manager/shared-types';
import {
  afterAction,
  BADGE,
  ICON,
  notificationFor,
  parsePayload,
  safePath,
  sendApprovalAction,
  type NotificationData,
} from './notifications';
import {
  dropOldShares,
  readShareForm,
  SHARE_CACHE,
  SHARE_TARGET_PATH,
  storeShare,
} from './share-store';
import {
  ASSET_CACHE,
  handledRequest,
  isAppShell,
  isHashedAsset,
  MAX_ASSETS,
  NAVIGATION_TIMEOUT_MS,
  serverDown,
  SHELL_CACHE,
  SHELL_KEY,
  storable,
} from './shell-cache';

declare const self: ServiceWorkerGlobalScope;

const CACHES = [SHELL_CACHE, ASSET_CACHE, SHARE_CACHE];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // The shell for offline starts; fails quietly when signed out.
      try {
        await refreshShell(
          await fetch('/', { credentials: 'same-origin', redirect: 'manual' }),
        );
      } catch {
        // Offline: cached on the next navigation.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('crm-') && !CACHES.includes(name)) {
          await caches.delete(name);
        }
      }
      await dropOldShares(await caches.open(SHARE_CACHE));
      await self.clients.claim();
    })(),
  );
});

// --- Fetch: offline shell and share target ----------------------------------

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method === 'POST' &&
    url.origin === self.location.origin &&
    url.pathname === SHARE_TARGET_PATH
  ) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (!handledRequest(request, self.location.origin)) {
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
  } else {
    event.respondWith(asset(request));
  }
});

async function refreshShell(response: Response): Promise<void> {
  if (await isAppShell(response)) {
    await (await caches.open(SHELL_CACHE)).put(SHELL_KEY, response.clone());
  }
}

async function navigate(request: Request): Promise<Response> {
  const network = fetch(request);
  // Kept only when it is the app itself (never a login page or redirect).
  network
    .then((response) => refreshShell(response.clone()))
    .catch(() => undefined);
  const cachedShell = async () =>
    (await caches.open(SHELL_CACHE)).match(SHELL_KEY);
  try {
    const first = await Promise.race([
      network,
      new Promise<'slow'>((resolve) =>
        setTimeout(() => resolve('slow'), NAVIGATION_TIMEOUT_MS),
      ),
    ]);
    if (first === 'slow') {
      // A slow network: start from the cached shell, if there is one.
      return (await cachedShell()) ?? (await network);
    }
    // The server is down behind a working proxy or tunnel (502, 503, …):
    // the app starts from the cache and shows what it knew.
    return serverDown(first) ? ((await cachedShell()) ?? first) : first;
  } catch {
    return (await cachedShell()) ?? Response.error();
  }
}

async function asset(request: Request): Promise<Response> {
  const cache = await caches.open(ASSET_CACHE);
  const url = new URL(request.url);
  const cached = await cache.match(request);
  if (cached && isHashedAsset(url.pathname)) {
    return cached;
  }
  try {
    const response = await fetch(request);
    if (storable(response)) {
      void cache
        .put(request, response.clone())
        .then(() => pruneAssets(cache))
        .catch(() => undefined);
    }
    return response;
  } catch (error) {
    if (cached) {
      return cached;
    }
    throw error;
  }
}

/** Files of old builds go first once the cache holds more than enough. */
async function pruneAssets(cache: Cache): Promise<void> {
  const keys = await cache.keys();
  for (const request of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) {
    await cache.delete(request);
  }
}

async function receiveShare(request: Request): Promise<Response> {
  const id = crypto.randomUUID();
  try {
    const content = readShareForm(await request.formData());
    await storeShare(await caches.open(SHARE_CACHE), id, content);
    return Response.redirect(`/?share=${id}`, 303);
  } catch {
    return Response.redirect('/?share=failed', 303);
  }
}

// --- Push ---------------------------------------------------------------------

self.addEventListener('push', (event) => {
  const payload = parsePayload(event.data?.text() ?? null);
  if (!payload) {
    return;
  }
  event.waitUntil(handlePush(payload));
});

async function handlePush(payload: PushPayload): Promise<void> {
  await setBadge(payload.badge);
  if (payload.type === 'withdraw') {
    for (const tag of payload.tags) {
      for (const notification of await self.registration.getNotifications({
        tag,
      })) {
        notification.close();
      }
    }
    return;
  }
  const { title, options } = notificationFor(payload);
  await self.registration.showNotification(
    title,
    options as NotificationOptions,
  );
}

async function setBadge(count: number | null): Promise<void> {
  const badge = self.navigator as WorkerNavigator & {
    setAppBadge?: (count: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  if (count === null) {
    return;
  }
  try {
    if (count > 0) {
      await badge.setAppBadge?.(count);
    } else {
      await badge.clearAppBadge?.();
    }
  } catch {
    // Not supported (or not installed).
  }
}

// --- Notification clicks ------------------------------------------------------

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const data = (notification.data ?? {}) as Partial<NotificationData>;
  const target: NotificationData = {
    url: safePath(data.url ?? '/'),
    sessionId: data.sessionId ?? null,
    requestId: data.requestId ?? null,
  };
  const action = event.action;
  notification.close();
  if (action === 'allow' || action === 'deny') {
    event.waitUntil(answer(notification, target, action));
  } else {
    event.waitUntil(openApp(target.url));
  }
});

/**
 * Answers an approval from its notification. When it did not get through,
 * the session opens with the request still pending, and a notification
 * says so: the user never believes an answer was given that was not.
 */
async function answer(
  notification: Notification,
  target: NotificationData,
  action: ApprovalAction,
): Promise<void> {
  const outcome = await sendApprovalAction(
    (url, init) => fetch(url, init),
    target,
    action,
  );
  const { notice, open } = afterAction(outcome, action);
  // First the notice: it must be there even if no window can be opened.
  if (notice) {
    await self.registration.showNotification(notice.title, {
      body: [notice.body, notification.body].filter(Boolean).join('\n'),
      tag: notification.tag,
      icon: ICON,
      badge: BADGE,
      data: { ...target, requestId: null },
    });
  }
  if (open) {
    await openApp(target.url);
  }
}

/**
 * Focuses a window of the app on the path, or opens one. Navigating there
 * also leads through the Access login when the sign-in expired.
 */
async function openApp(path: string): Promise<void> {
  try {
    await focusOrOpen(path);
  } catch {
    // No window may be opened (e.g. the click is too long ago).
  }
}

async function focusOrOpen(path: string): Promise<void> {
  const url = new URL(path, self.location.origin).href;
  const windows = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  const existing = windows.find(
    (client) => new URL(client.url).origin === self.location.origin,
  );
  if (existing) {
    try {
      const navigated = await existing.navigate(url);
      await (navigated ?? existing).focus();
      return;
    } catch {
      // Not controlled by this worker: open a new window instead.
    }
  }
  await self.clients.openWindow(url);
}

// --- Subscription renewal -----------------------------------------------------

self.addEventListener('pushsubscriptionchange', (event) => {
  const change = event as Event & {
    oldSubscription?: PushSubscription | null;
    newSubscription?: PushSubscription | null;
    waitUntil(promise: Promise<unknown>): void;
  };
  change.waitUntil(
    (async () => {
      const key = change.oldSubscription?.options.applicationServerKey;
      const subscription =
        change.newSubscription ??
        (key
          ? await self.registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: key,
            })
          : null);
      if (!subscription) {
        return;
      }
      await fetch('/api/notifications/push-subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
        credentials: 'same-origin',
        redirect: 'manual',
      });
      if (change.oldSubscription) {
        await fetch('/api/notifications/push-subscriptions/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: change.oldSubscription.endpoint }),
          credentials: 'same-origin',
          redirect: 'manual',
        });
      }
    })().catch(() => undefined),
  );
});
