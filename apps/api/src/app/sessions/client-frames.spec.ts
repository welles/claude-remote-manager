import { BadRequestException } from '@nestjs/common';
import { isUuid, optionalInteger, requireString } from '../common/validation';
import { parseClientFrame } from './client-frames';

const SESSION = '11111111-2222-4333-8444-555555555555';
const MESSAGE = '66666666-7777-4888-9999-aaaaaaaaaaaa';

describe('parseClientFrame', () => {
  it('accepts valid frames and drops unknown fields', () => {
    expect(
      parseClientFrame({ type: 'subscribe', sessionId: SESSION, extra: 1 }),
    ).toEqual({ type: 'subscribe', sessionId: SESSION });
    expect(
      parseClientFrame({
        type: 'message.send',
        sessionId: SESSION,
        id: MESSAGE,
        text: 'hi',
        requestId: 'r1',
      }),
    ).toEqual({
      type: 'message.send',
      sessionId: SESSION,
      id: MESSAGE,
      text: 'hi',
      requestId: 'r1',
    });
    expect(parseClientFrame({ type: 'interrupt', sessionId: SESSION })).toEqual(
      { type: 'interrupt', sessionId: SESSION },
    );
  });

  it.each([
    [null, 'frame must be a JSON object'],
    [[], 'frame must be a JSON object'],
    [{}, 'type must be a string'],
    [{ type: 'subscribe' }, 'sessionId must be a UUID'],
    [{ type: 'subscribe', sessionId: 'abc' }, 'sessionId must be a UUID'],
    [
      { type: 'message.send', sessionId: SESSION, id: 'x', text: 'a' },
      'id must be a UUID',
    ],
    [
      { type: 'message.send', sessionId: SESSION, id: MESSAGE },
      'text must be a string',
    ],
    [{ type: 'subscribe', sessionId: SESSION, requestId: 5 }, 'requestId'],
    [{ type: 'permission.respond' }, 'not supported'],
    [{ type: 'other' }, 'Unknown frame type other'],
  ])('rejects %j', (frame, message) => {
    expect(() => parseClientFrame(frame)).toThrow(BadRequestException);
    expect(() => parseClientFrame(frame)).toThrow(message);
  });
});

describe('validation helpers', () => {
  it('checks UUIDs, strings and integers', () => {
    expect(isUuid(SESSION)).toBe(true);
    expect(isUuid('11111111-2222-3333-4444-555555555555')).toBe(false);
    expect(() => requireString({ a: 'x' }, 'a', { maxLength: 0 })).toThrow(
      'longer than 0',
    );
    expect(optionalInteger({ n: 3 }, 'n')).toBe(3);
    expect(optionalInteger({}, 'n')).toBeUndefined();
    expect(() => optionalInteger({ n: -1 }, 'n')).toThrow('integer >= 0');
    expect(() => optionalInteger({ n: 1.5 }, 'n')).toThrow('integer');
  });
});
