import type { PushPayload } from '@claude-remote-manager/shared-types';
import type { FetchLike } from '../ntfy.channel';
import { PushSender, type PushOptions } from '../web-push.channel';

/** A push message as the fake push service received it. */
export interface SentPush {
  endpoint: string;
  payload: PushPayload;
  options: PushOptions;
  subject: string;
}

/** Records pushes instead of sending them; answers with `status` per endpoint. */
export class RecordingPushSender extends PushSender {
  readonly sent: SentPush[] = [];
  /** HTTP status the push service answers for an endpoint (default 201). */
  readonly status = new Map<string, number>();

  async send(
    subscription: { endpoint: string },
    payload: string,
    options: PushOptions,
    vapid: { subject: string },
  ): Promise<void> {
    const status = this.status.get(subscription.endpoint) ?? 201;
    if (status >= 300) {
      throw Object.assign(new Error(`Received unexpected response code`), {
        statusCode: status,
        endpoint: subscription.endpoint,
        body: 'gone',
      });
    }
    this.sent.push({
      endpoint: subscription.endpoint,
      payload: JSON.parse(payload) as PushPayload,
      options,
      subject: vapid.subject,
    });
  }

  /** Payloads of a type, in order. */
  payloads<T extends PushPayload['type']>(
    type: T,
  ): Extract<PushPayload, { type: T }>[] {
    return this.sent
      .map((push) => push.payload)
      .filter(
        (payload): payload is Extract<PushPayload, { type: T }> =>
          payload.type === type,
      );
  }
}

/** A request the fake ntfy server got. */
export interface NtfyRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** An ntfy server answering from `respond` (default: 200). */
export class FakeNtfy {
  readonly requests: NtfyRequest[] = [];
  respond: (request: NtfyRequest) => Response = () =>
    new Response('{"id":"x"}', { status: 200 });

  readonly fetch: FetchLike = async (url, init) => {
    const request: NtfyRequest = {
      url,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    };
    this.requests.push(request);
    return this.respond(request);
  };

  /** Messages published (POST bodies). */
  get messages(): Record<string, unknown>[] {
    return this.requests
      .filter((request) => request.method === 'POST')
      .map((request) => request.body ?? {});
  }
}
