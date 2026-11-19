import type { SessionEventInput } from '@claude-remote-manager/shared-types';
import type { StoredEvent } from './session-event.repository';
import { buildHistory, SessionLog } from './session-log';
import type { TranscriptEntry } from './sdk-event-mapper';

const delta = (text: string, blockIndex = 0): SessionEventInput => ({
  type: 'assistant.delta',
  messageId: 'm1',
  blockIndex,
  text,
  parentToolUseId: null,
});
const notice = (text: string): SessionEventInput => ({
  type: 'notice',
  level: 'info',
  text,
});

describe('SessionLog', () => {
  it('keeps deltas out of the log and as drafts until the block completes', () => {
    const log = new SessionLog();
    log.append({ type: 'user.message', id: 'u', text: 'Hi' });
    expect(log.append(delta('Hel'))).toMatchObject({ seq: 2 });
    log.append(delta('lo'));
    log.append(delta('x', 1));

    let snapshot = log.snapshot();
    expect(snapshot.events.map((event) => event.type)).toEqual([
      'user.message',
    ]);
    expect(snapshot.drafts).toEqual([
      { messageId: 'm1', blockIndex: 0, text: 'Hello', parentToolUseId: null },
      { messageId: 'm1', blockIndex: 1, text: 'x', parentToolUseId: null },
    ]);

    log.append({
      type: 'assistant.text',
      messageId: 'm1',
      blockIndex: 0,
      text: 'Hello!',
      parentToolUseId: null,
    });
    snapshot = log.snapshot();
    expect(snapshot.events.map((event) => event.seq)).toEqual([1, 5]);
    expect(snapshot.drafts.map((draft) => draft.blockIndex)).toEqual([1]);
    expect(log.lastAssistantText).toBe('Hello!');
    log.clearDrafts();
    expect(log.snapshot().drafts).toEqual([]);
  });

  it('returns only newer events for a known position', () => {
    const log = new SessionLog();
    for (let index = 1; index <= 10; index++) {
      log.append(notice(String(index)));
      if (index % 3 === 0) {
        log.append(delta('.')); // seq numbers with gaps in the log
      }
    }
    const all = log.snapshot();
    expect(all.complete).toBe(true);
    expect(all.events).toHaveLength(10);

    for (const event of all.events) {
      const part = log.snapshot({ logId: log.id, seq: event.seq });
      expect(part.complete).toBe(false);
      expect(part.events).toEqual(all.events.filter((e) => e.seq > event.seq));
    }
    expect(log.snapshot({ logId: log.id, seq: 0 }).events).toHaveLength(10);
    // A delta's seq (not in the log) works too.
    expect(log.snapshot({ logId: log.id, seq: 4 }).events[0].seq).toBe(5);
  });

  it('sends everything for another log or an impossible position', () => {
    const log = new SessionLog();
    log.append(notice('a'));
    expect(log.snapshot({ logId: 'other', seq: 1 }).complete).toBe(true);
    expect(log.snapshot({ logId: log.id, seq: 99 }).complete).toBe(true);
  });

  it('finds the last event of a type', () => {
    const log = new SessionLog();
    log.append(notice('a'));
    log.append(notice('b'));
    expect(log.findLast('notice')?.text).toBe('b');
    expect(log.findLast('error')).toBeUndefined();
  });
});

describe('buildHistory', () => {
  const user = (uuid: string, text: string): TranscriptEntry => ({
    uuid,
    isUserMessage: true,
    events: [{ type: 'user.message', id: uuid, text }],
  });
  const assistant = (uuid: string, text: string): TranscriptEntry => ({
    uuid,
    isUserMessage: false,
    events: [
      {
        type: 'assistant.text',
        messageId: uuid,
        blockIndex: null,
        text,
        parentToolUseId: null,
      },
    ],
  });
  const stored = (
    text: string,
    uuid: string | null,
    userId: string | null,
  ): StoredEvent => ({
    event: notice(text),
    anchor: { uuid, userId },
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  const texts = (items: ReturnType<typeof buildHistory>) =>
    items.map(({ event }) =>
      event.type === 'notice'
        ? `notice:${event.text}`
        : event.type === 'user.message' || event.type === 'assistant.text'
          ? event.text
          : event.type,
    );

  it('places stored events after their anchor entry', () => {
    const items = buildHistory(
      [
        user('u1', 'q1'),
        assistant('a1', 'r1'),
        user('u2', 'q2'),
        assistant('a2', 'r2'),
      ],
      [
        stored('unanchored', null, null),
        stored('after a1', 'a1', 'u1'),
        stored('turn 1 end', 'lost', 'u1'),
        stored('after u2', 'u2', 'u2'),
        stored('unknown', 'lost', 'lost'),
      ],
    );
    expect(texts(items)).toEqual([
      'q1',
      'r1',
      'notice:after a1',
      'notice:turn 1 end',
      'q2',
      'notice:after u2',
      'r2',
      'notice:unanchored',
      'notice:unknown',
    ]);
  });

  it('dates stored events and leaves transcript events undated', () => {
    const items = buildHistory([user('u1', 'q')], [stored('n', 'u1', 'u1')]);
    expect(items.map((item) => item.at)).toEqual([
      null,
      '2026-01-01T00:00:00.000Z',
    ]);
  });

  it('keeps only the newest prompt suggestion', () => {
    const suggestion = (text: string, uuid: string): StoredEvent => ({
      event: { type: 'prompt.suggestion', text },
      anchor: { uuid, userId: null },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const items = buildHistory(
      [user('u2', 'q2'), assistant('a2', 'r2')],
      // The first one's entry was compacted away: it would go to the end.
      [suggestion('old', 'gone'), suggestion('new', 'a2')],
    );
    expect(
      items.flatMap(({ event }) =>
        event.type === 'prompt.suggestion' ? [event.text] : [],
      ),
    ).toEqual(['new']);
  });

  it('drops a prompt suggestion whose turn is no longer in the transcript', () => {
    const items = buildHistory(
      [user('u2', 'q2'), assistant('a2', 'r2')],
      [
        {
          event: { type: 'prompt.suggestion', text: 'answered' },
          anchor: { uuid: 'gone', userId: 'gone-too' },
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    );
    expect(texts(items)).toEqual(['q2', 'r2']);
  });

  it('keeps stored events without a transcript', () => {
    expect(
      texts(buildHistory([], [stored('failed to start', 'x', 'x')])),
    ).toEqual(['notice:failed to start']);
  });
});
