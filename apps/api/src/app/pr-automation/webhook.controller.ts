import { Controller, Inject, Logger, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { IncomingHttpHeaders } from 'node:http';
import { WebhookDeliveryRepository } from './webhook-deliveries.repository';
import { WebhookSecret } from './webhook-signature';

/** Path of the GitHub App's webhook. */
export const WEBHOOK_PATH = '/api/github/webhook';
/** Largest delivery accepted; larger ones are refused with 413. */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
/** Events the PR automation uses; others are acknowledged and ignored. */
export const WEBHOOK_EVENTS: ReadonlySet<string> = new Set([
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
  'check_run',
  'check_suite',
  'status',
  'ping',
]);

/** Gets the deliveries that passed all checks (see PrAutomationService). */
export abstract class WebhookHandler {
  abstract onWebhook(event: string, payload: unknown): void;
}

export interface WebhookAnswer {
  status: number;
  message: string;
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  return typeof value === 'string' ? value : null;
}

/**
 * Checks a webhook delivery. The route is exempt from the Cloudflare Access
 * check and the request guard (GitHub has neither an Access login nor a
 * browser's headers); the signature is its only authentication:
 * - without a configured secret every delivery is refused;
 * - the body is read raw (at most {@link WEBHOOK_MAX_BODY_BYTES}, JSON only)
 *   and its HMAC-SHA256 compared in constant time with
 *   `X-Hub-Signature-256` before anything else is looked at;
 * - deliveries already processed (`X-GitHub-Delivery`) are not processed
 *   again; events the automation does not use are ignored.
 * What a delivery says is only a signal: the automation reads the current
 * state of the pull request from GitHub's API itself.
 */
export function checkDelivery(
  secret: WebhookSecret,
  deliveries: Pick<WebhookDeliveryRepository, 'record'>,
  headers: IncomingHttpHeaders,
  body: unknown,
): { answer: WebhookAnswer; event?: string; payload?: unknown } {
  if (!secret.configured) {
    return {
      answer: { status: 503, message: 'The webhook secret is not configured' },
    };
  }
  if (!Buffer.isBuffer(body)) {
    return {
      answer: { status: 415, message: 'The body must be application/json' },
    };
  }
  const verdict = secret.verify(body, headers['x-hub-signature-256']);
  if (verdict !== 'ok') {
    return {
      answer: {
        status: 401,
        message:
          verdict === 'missing'
            ? 'The signature is missing'
            : 'The signature is invalid',
      },
    };
  }
  const event = header(headers, 'x-github-event');
  const delivery = header(headers, 'x-github-delivery');
  if (
    !event ||
    !/^[a-z_]{1,64}$/.test(event) ||
    !delivery ||
    !/^[A-Za-z0-9-]{1,100}$/.test(delivery)
  ) {
    return {
      answer: { status: 400, message: 'Event or delivery ID missing' },
    };
  }
  if (!WEBHOOK_EVENTS.has(event)) {
    return { answer: { status: 202, message: 'Event ignored' } };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return { answer: { status: 400, message: 'The body is not JSON' } };
  }
  if (!deliveries.record(delivery, event)) {
    return { answer: { status: 200, message: 'Delivery processed already' } };
  }
  if (event === 'ping') {
    return { answer: { status: 200, message: 'pong' } };
  }
  return { answer: { status: 202, message: 'Accepted' }, event, payload };
}

/** `POST /api/github/webhook`: deliveries of the GitHub App's webhook. */
@Controller('github')
export class WebhookController {
  private readonly logger = new Logger('GitHubWebhook');

  constructor(
    private readonly secret: WebhookSecret,
    private readonly deliveries: WebhookDeliveryRepository,
    @Inject(WebhookHandler) private readonly handler: WebhookHandler,
  ) {}

  @Post('webhook')
  receive(@Req() request: Request, @Res() response: Response): void {
    const { answer, event, payload } = checkDelivery(
      this.secret,
      this.deliveries,
      request.headers,
      request.body,
    );
    if (answer.status >= 400) {
      this.logger.warn(`Refused a webhook delivery: ${answer.message}`);
    }
    response.status(answer.status).json({
      statusCode: answer.status,
      message: answer.message,
    });
    if (event && payload !== undefined) {
      this.handler.onWebhook(event, payload);
    }
  }
}
