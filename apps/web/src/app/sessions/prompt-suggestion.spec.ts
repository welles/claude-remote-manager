import type { SessionEvent } from '@claude-remote-manager/shared-types';
import { applySuggestion } from './prompt-suggestion';

const at = null;

describe('applySuggestion', () => {
  it('takes the latest suggestion and keeps it across other events', () => {
    const events: SessionEvent[] = [
      { type: 'prompt.suggestion', text: 'run the tests', seq: 1, at },
      { type: 'prompt.suggestion', text: 'commit this', seq: 2, at },
      { type: 'session.status', status: 'waiting', seq: 3, at },
    ];
    expect(events.reduce(applySuggestion, null)).toBe('commit this');
  });

  it('drops the suggestion once the user sends or queues a message', () => {
    const suggestion: SessionEvent = {
      type: 'prompt.suggestion',
      text: 'run the tests',
      seq: 1,
      at,
    };
    expect(
      applySuggestion('x', {
        type: 'user.message',
        id: 'm',
        text: 'hi',
        seq: 2,
        at,
      }),
    ).toBeNull();
    expect(
      [
        suggestion,
        {
          type: 'message.queued',
          id: 'm',
          text: 'hi',
          seq: 2,
          at,
        } as SessionEvent,
      ].reduce(applySuggestion, null),
    ).toBeNull();
  });

  it('drops the suggestion when a turn starts on its own', () => {
    expect(
      applySuggestion('x', {
        type: 'session.status',
        status: 'running',
        seq: 2,
        at,
      }),
    ).toBeNull();
  });
});
