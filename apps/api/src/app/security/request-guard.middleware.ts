import {
  Inject,
  Injectable,
  Logger,
  type NestMiddleware,
} from '@nestjs/common';
import type { RouteInfo } from '@nestjs/common/interfaces';
import type { NextFunction, Request, Response } from 'express';
import { ATTACHMENT_MEDIA_TYPES } from '@claude-remote-manager/shared-types';
import { RequestPolicy } from './request-policy';

/**
 * Routes the request guard does not check, e.g. a webhook endpoint that
 * verifies a signature instead. Add exemptions here, each with a reason.
 */
export const REQUEST_GUARD_EXEMPT_ROUTES: RouteInfo[] = [];

/**
 * The only routes whose bodies are not JSON, with the content types they
 * take (all other checks of the guard apply). Safe against cross-site
 * requests: HTML forms cannot send these types, and a foreign page's
 * `fetch` with them needs a CORS preflight, which the API never answers
 * (and its `Origin` is refused).
 * - image uploads for messages (the controller limits the size).
 */
export const RAW_BODY_ROUTES: readonly {
  method: string;
  path: string;
  types: readonly string[];
}[] = [
  {
    method: 'POST',
    path: '/api/attachments',
    types: ATTACHMENT_MEDIA_TYPES,
  },
];

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hasBody(request: Request): boolean {
  const length = request.headers['content-length'];
  return (
    request.headers['transfer-encoding'] !== undefined ||
    (length !== undefined && length !== '0')
  );
}

/**
 * Applies the {@link RequestPolicy} and accepts only JSON request bodies,
 * except the image types of {@link RAW_BODY_ROUTES} on those routes.
 */
@Injectable()
export class RequestGuardMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestGuardMiddleware.name);

  constructor(@Inject(RequestPolicy) private readonly policy: RequestPolicy) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const verdict = this.policy.check(request.method, request.headers);
    if (!verdict.ok) {
      this.logger.warn(
        `Refused ${request.method} ${request.originalUrl}: ${verdict.reason}`,
      );
      response.status(verdict.status).json({
        statusCode: verdict.status,
        message: verdict.reason,
      });
      return;
    }
    if (BODY_METHODS.has(request.method) && hasBody(request)) {
      const path = request.originalUrl.split('?')[0].replace(/\/+$/, '');
      const raw = RAW_BODY_ROUTES.find(
        (route) => route.method === request.method && route.path === path,
      );
      const types = raw ? [...raw.types] : ['application/json'];
      if (!request.is(types)) {
        response.status(415).json({
          statusCode: 415,
          message: `Request bodies must be ${types.join(' or ')}`,
        });
        return;
      }
    }
    next();
  }
}
