import { BadRequestException } from '@nestjs/common';
import type { ClientMessage } from '@claude-remote-manager/shared-types';
import {
  optionalString,
  requireObject,
  requireString,
  requireInteger,
  requireUuid,
} from '../common/validation';

const MAX_REQUEST_ID_LENGTH = 100;

/**
 * Validates a client frame of the WebSocket protocol. Throws
 * BadRequestException for malformed frames. Message text limits are checked
 * by the session service, as for REST.
 */
export function parseClientFrame(raw: unknown): ClientMessage {
  const frame = requireObject(raw, 'frame');
  const type = requireString(frame, 'type');
  const requestId = optionalString(frame, 'requestId', {
    maxLength: MAX_REQUEST_ID_LENGTH,
  });
  const base = requestId === undefined ? {} : { requestId };
  switch (type) {
    case 'subscribe': {
      const after =
        frame['after'] === undefined || frame['after'] === null
          ? undefined
          : requireObject(frame['after'], 'after');
      return {
        type,
        sessionId: requireUuid(frame, 'sessionId'),
        ...(after
          ? {
              after: {
                logId: requireUuid(after, 'logId'),
                seq: requireInteger(after, 'seq'),
              },
            }
          : {}),
        ...base,
      };
    }
    case 'unsubscribe':
    case 'interrupt':
    case 'session.end':
    case 'pending.send':
    case 'setup.rerun':
      return { type, sessionId: requireUuid(frame, 'sessionId'), ...base };
    case 'message.send':
      return {
        type,
        sessionId: requireUuid(frame, 'sessionId'),
        id: requireUuid(frame, 'id'),
        text: requireString(frame, 'text'),
        ...base,
      };
    case 'permission.respond':
      throw new BadRequestException(
        'Permission requests are not supported yet',
      );
    default:
      throw new BadRequestException(`Unknown frame type ${type}`);
  }
}
