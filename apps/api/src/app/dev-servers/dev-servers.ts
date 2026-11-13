/**
 * Dev servers of sessions: what ends them when a session ends (the user
 * ends it, autoclose, later the cleanup). Implemented by the previews
 * (`previews/previews.service.ts`): it stops the session's previews and
 * the dev servers listening on their ports.
 */
export abstract class DevServers {
  /** Stops the session's dev servers and removes their forwarding. */
  abstract stopSession(sessionId: string): Promise<void>;
}
