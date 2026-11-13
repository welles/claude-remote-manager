import type { MessageReference } from '@claude-remote-manager/shared-types';
import { messageSegments } from './message-text';
import { referenceQuery } from './reference-autocomplete';
import { draftReferences, optionsOf } from './references';

const reference = (token: string, number: number): MessageReference => ({
  token,
  repository: token.includes('/') ? token.split('#')[0] : 'acme/app',
  number,
  comments: false,
  diff: false,
  status: 'resolved',
  kind: 'issue',
  title: `Issue ${number}`,
  state: 'open',
  draft: false,
  url: `https://github.com/acme/app/issues/${number}`,
  error: null,
  notes: [],
});

describe('GitHub references in the web app', () => {
  it('finds the # reference being typed', () => {
    expect(referenceQuery('Fix #12')).toEqual({
      start: 4,
      repository: null,
      text: '12',
    });
    expect(referenceQuery('see (acme/lib#log')).toEqual({
      start: 5,
      repository: 'acme/lib',
      text: 'log',
    });
    expect(referenceQuery('#')).toEqual({
      start: 0,
      repository: null,
      text: '',
    });
    expect(referenceQuery('Fix #12 ')).toBeNull();
    expect(referenceQuery('page#12')).toBeNull();
  });

  it('lists the references of a draft once, with their extras', () => {
    const options = new Map([['acme/app#12', { comments: true, diff: false }]]);
    expect(
      draftReferences(
        'Fix #12, #12 and acme/lib#3; `#4`',
        ['acme/app', 'acme/lib'],
        options,
      ),
    ).toEqual([
      { token: '#12', repository: 'acme/app', number: 12, comments: true },
      { token: 'acme/lib#3', repository: 'acme/lib', number: 3 },
    ]);
    // Without a GitHub repository, #12 refers to nothing.
    expect(draftReferences('Fix #12', [], new Map())).toEqual([]);
    expect(
      optionsOf([{ ...reference('#12', 12), diff: true }]).get('acme/app#12'),
    ).toEqual({ comments: false, diff: true });
  });

  it('puts chips where the references are in a sent message', () => {
    const segments = messageSegments('Fix #12 and acme/lib#3!', [
      reference('#12', 12),
      reference('acme/lib#3', 3),
      reference('#9', 9),
    ]);
    expect(
      segments.map((segment) =>
        segment.kind === 'text' ? segment.text : `[${segment.chip.token}]`,
      ),
    ).toEqual(['Fix ', '[#12]', ' and ', '[acme/lib#3]', '!', '\n', '[#9]']);
    expect(messageSegments('Hi', [])).toEqual([{ kind: 'text', text: 'Hi' }]);
  });
});
