/**
 * Registers the service worker (`/sw.js`, see src/sw/worker.ts): offline
 * shell, Web Push with notification actions, badge and share target.
 * Service workers need a secure context (https, or localhost).
 */
export function registerServiceWorker(
  container: ServiceWorkerContainer | undefined = navigator.serviceWorker,
): void {
  if (!container || !globalThis.isSecureContext) {
    return;
  }
  // Checks for a new version of the worker on every start (a new build).
  const register = () =>
    container
      .register('/sw.js', { scope: '/' })
      .then((registration) => registration.update())
      .catch(() => undefined);
  if (document.readyState === 'complete') {
    void register();
  } else {
    addEventListener('load', () => void register(), { once: true });
  }
}
