import type { IncomingHttpHeaders } from 'node:http';
import { AccessJwtVerifier, AccessTokenError } from '../auth/access-jwt';
import {
  accessToken,
  fromSessionProcess,
  type AuthConfig,
  type PeerLookup,
  type PeerSocket,
  type SessionSocketCheck,
} from '../auth/authenticator';
import { loopbackPeer } from '../auth/peer-credentials';
import { heldByApiChild } from '../auth/session-processes';
import type { ProcessIsolation } from '../common/process-isolation';
import type { PreviewConfig } from '../config/app-config';

export type PreviewAccessVerdict =
  | { ok: true }
  | { ok: false; status: 401 | 403; message: string };

/**
 * Who may open a preview:
 * - never a session process, like the management API:
 *   sessions reach their dev servers directly;
 * - with `AUTH_MODE=cloudflare-access`, only requests with a valid Access
 *   token of the preview hosts' own Access application (audience
 *   `PREVIEW_ACCESS_AUD`, same team and email allowlist as the app). The
 *   app's audience is not accepted here, and the API does not accept the
 *   preview audience: a token a preview page could get hold of is
 *   worthless against the API.
 */
export class PreviewAccess {
  readonly verifier: AccessJwtVerifier | null;

  constructor(
    auth: AuthConfig,
    previews: PreviewConfig,
    private readonly isolation: ProcessIsolation,
    verifier?: AccessJwtVerifier | null,
    private readonly peer: PeerLookup = loopbackPeer,
    private readonly startedByApi: SessionSocketCheck = heldByApiChild,
  ) {
    this.verifier =
      verifier !== undefined
        ? verifier
        : auth.mode === 'cloudflare-access'
          ? new AccessJwtVerifier({
              ...auth.access,
              audiences: previews.accessAudiences,
            })
          : null;
  }

  async check(
    headers: IncomingHttpHeaders,
    socket: PeerSocket,
  ): Promise<PreviewAccessVerdict> {
    if (
      fromSessionProcess(this.isolation, socket, this.peer, this.startedByApi)
    ) {
      return {
        ok: false,
        status: 403,
        message:
          'Session processes cannot open previews; connect to the dev server on localhost directly',
      };
    }
    if (!this.verifier) {
      return { ok: true };
    }
    try {
      await this.verifier.verify(accessToken(headers));
      return { ok: true };
    } catch (error) {
      if (error instanceof AccessTokenError) {
        return {
          ok: false,
          status: error.reason === 'access_email_not_allowed' ? 403 : 401,
          message: error.message,
        };
      }
      throw error;
    }
  }
}
