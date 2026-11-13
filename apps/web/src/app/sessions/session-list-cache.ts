import type { SessionDto } from '@claude-remote-manager/shared-types';

/**
 * The last known session list, kept in this browser so that the app can
 * show it when the server cannot be reached (offline shell). Shown marked
 * as stale, with the time it was loaded.
 */
export const SESSION_LIST_KEY = 'crm.sessionList.v1';

export interface CachedSessionList {
  savedAt: string;
  sessions: SessionDto[];
}

export function saveSessionList(
  sessions: SessionDto[],
  storage: Storage | null = safeStorage(),
  now = new Date(),
): void {
  try {
    storage?.setItem(
      SESSION_LIST_KEY,
      JSON.stringify({ savedAt: now.toISOString(), sessions }),
    );
  } catch {
    // Full or not allowed: the offline list is a convenience.
  }
}

export function loadSessionList(
  storage: Storage | null = safeStorage(),
): CachedSessionList | null {
  try {
    const raw = storage?.getItem(SESSION_LIST_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as CachedSessionList;
    return typeof parsed.savedAt === 'string' && Array.isArray(parsed.sessions)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
