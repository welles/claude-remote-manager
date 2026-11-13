import { BadRequestException } from '@nestjs/common';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  type ClientMessage,
  type MessageReferenceRequest,
  type PermissionResponse,
  type UpdateSessionRequest,
} from '@claude-remote-manager/shared-types';
import {
  optionalString,
  optionalUuidArray,
  requireObject,
  requireString,
  requireInteger,
  requireUuid,
} from '../common/validation';

const MAX_REQUEST_ID_LENGTH = 100;

/** Fields of an answer to an approval request (`PermissionResponse`). */
export const PERMISSION_ANSWER_FIELDS = [
  'decision',
  'scope',
  'message',
  'answers',
  'mode',
] as const;
/** Fields of `UpdateSessionRequest`. */
export const SESSION_UPDATE_FIELDS = ['model', 'permissionMode'] as const;

/** The given fields of an object that are present. */
export function pick(
  object: object,
  fields: readonly string[],
): Record<string, unknown> {
  const source = object as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (source[field] !== undefined) {
      picked[field] = source[field];
    }
  }
  return picked;
}

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
        ...(frame['attachmentIds'] !== undefined
          ? {
              attachmentIds: optionalUuidArray(
                frame,
                'attachmentIds',
                MAX_ATTACHMENTS_PER_MESSAGE,
              ),
            }
          : {}),
        // Validated by the session service, as for REST.
        ...(frame['references'] !== undefined
          ? {
              references: frame['references'] as MessageReferenceRequest[],
            }
          : {}),
        ...base,
      };
    case 'permission.respond':
      if (requestId === undefined) {
        throw new BadRequestException('requestId must be a string');
      }
      // The answer is validated against the request it answers.
      return {
        ...(pick(
          frame,
          PERMISSION_ANSWER_FIELDS,
        ) as unknown as PermissionResponse),
        type,
        sessionId: requireUuid(frame, 'sessionId'),
        permissionRequestId: requireUuid(frame, 'permissionRequestId'),
        requestId,
      };
    case 'presence': {
      const sessionId = frame['sessionId'];
      if (typeof frame['active'] !== 'boolean') {
        throw new BadRequestException('active must be a boolean');
      }
      return {
        type,
        sessionId:
          sessionId === null || sessionId === undefined
            ? null
            : requireUuid(frame, 'sessionId'),
        active: frame['active'],
        ...base,
      };
    }
    case 'message.unqueue':
      return {
        type,
        sessionId: requireUuid(frame, 'sessionId'),
        messageId: requireUuid(frame, 'messageId'),
        ...base,
      };
    case 'session.update':
      // Validated by the session service, as for REST.
      return {
        ...(pick(frame, SESSION_UPDATE_FIELDS) as UpdateSessionRequest),
        type,
        sessionId: requireUuid(frame, 'sessionId'),
        ...base,
      };
    default:
      throw new BadRequestException(`Unknown frame type ${type}`);
  }
}
