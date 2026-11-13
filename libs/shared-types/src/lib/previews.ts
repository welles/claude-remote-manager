/**
 * Previews of dev servers: Claude starts a dev server in a session and
 * exposes its port with the tool `expose_port`; the app forwards a host
 * name of its own to it (`<session-slug>-<port>.<preview domain>`),
 * HTTP and WebSockets, so the user opens the running app in the browser.
 */

/**
 * - `running`: something listens on the port, on loopback, as the session
 *   user: requests are forwarded;
 * - `unreachable`: exposed, but nothing (acceptable) listens on the port
 *   right now (not started yet, crashed, or bound elsewhere); the preview
 *   host shows a waiting page;
 * - `stopped`: the forwarding ended (by the user, by Claude, or because
 *   the session ended).
 */
export type PreviewState = 'running' | 'unreachable' | 'stopped';

/** Who stopped a preview. */
export type PreviewStopper = 'user' | 'claude' | 'session_end';

export interface PreviewDto {
  id: string;
  sessionId: string;
  port: number;
  /** Name Claude gave it, e.g. `Web app`. */
  name: string;
  /** Where the user opens it, e.g. `https://fix-login-k3x9q2-5173.preview.example.com`. */
  url: string;
  state: PreviewState;
  /** Why it is `unreachable`, for the user; `null` otherwise. */
  problem: string | null;
  createdAt: string;
  stoppedAt: string | null;
  stoppedBy: PreviewStopper | null;
}

/** Longest preview name. */
export const MAX_PREVIEW_NAME_LENGTH = 60;
/** Active previews per session. */
export const MAX_PREVIEWS_PER_SESSION = 10;

/**
 * Flags of the frame that embeds a preview in the session view. The
 * preview runs in its own origin (`allow-same-origin` gives it its own,
 * never the app's: it is another host), may run scripts, forms, dialogs
 * and popups, but may not navigate the app's window (no
 * `allow-top-navigation*`) and its popups stay sandboxed.
 */
export const PREVIEW_FRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-modals allow-popups';
