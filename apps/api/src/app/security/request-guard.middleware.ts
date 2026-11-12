import {
  Inject,
  Injectable,
  Logger,
  type NestMiddleware,
} from '@nestjs/common';
import type { RouteInfo } from '@nestjs/common/interfaces';
import type { NextFunction, Request, Response } from 'express';
import { RequestPolicy } from './request-policy';

/**
 * Routes the request guard does not check, e.g. a webhook endpoint that
 * verifies a signature instead. Add exemptions here, each with a reason.
 */
export const REQUEST_GUARD_EXEMPT_ROUTES: RouteInfo[] = [];

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hasBody(request: Request): boolean {
  const length = request.headers['content-length'];
  return (
    request.headers['transfer-encoding'] !== undefined ||
    (length !== undefined && length !== '0')
  );
}

/** Applies the {@link RequestPolicy} and accepts only JSON request bodies. */
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
    if (
      BODY_METHODS.has(request.method) &&
      hasBody(request) &&
      !request.is('application/json')
    ) {
      response.status(415).json({
        statusCode: 415,
        message: 'Request bodies must be application/json',
      });
      return;
    }
    next();
  }
}
