/**
 * Dev servers of sessions (spec step 10: `expose_port`, reverse proxy,
 * preview subdomains). Until then there are none; this is the hook that
 * ending a session through autoclose (and later the cleanup) calls, so the
 * dev-server step only has to implement it.
 */
export abstract class DevServers {
  /** Stops the session's dev servers and removes their forwarding. */
  abstract stopSession(sessionId: string): Promise<void>;
}

/** No dev servers yet. */
export class NoDevServers extends DevServers {
  async stopSession(): Promise<void> {
    // nothing to stop
  }
}
