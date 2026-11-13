import { createHash, randomBytes } from 'node:crypto';

const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/**
 * Tokens with which a session's processes authenticate to the API (the git
 * credential helper). One per running Claude Code process, random, kept
 * only as hash; it is given to the process in its environment and revoked
 * when the process ends. It identifies the session, nothing more: what it
 * can get is decided per request (repositories of that session only).
 */
export class SessionCredentials {
  private readonly bySession = new Map<string, string>();
  private readonly byHash = new Map<string, string>();

  /** A new token for the session; the previous one stops working. */
  issue(sessionId: string): string {
    this.revoke(sessionId);
    const token = `crm_${randomBytes(32).toString('base64url')}`;
    const digest = hash(token);
    this.bySession.set(sessionId, digest);
    this.byHash.set(digest, sessionId);
    return token;
  }

  /** Session of a token, or `null`. */
  resolve(token: string | null | undefined): string | null {
    if (!token || !token.startsWith('crm_')) {
      return null;
    }
    return this.byHash.get(hash(token)) ?? null;
  }

  revoke(sessionId: string): void {
    const digest = this.bySession.get(sessionId);
    if (digest) {
      this.byHash.delete(digest);
      this.bySession.delete(sessionId);
    }
  }
}
