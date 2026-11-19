import type { MessageReference } from '@claude-remote-manager/shared-types';
import { messageSegments } from './message-text';
import { referenceQuery } from './reference-autocomplete';
import {
  bareNumbers,
  draftReferences,
  optionsOf,
  qualifyReference,
  resolveBare,
  type DetailState,
} from './references';

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

  it('reads #12 as the repository repositoryOf names', () => {
    expect(
      draftReferences(
        'Fix #12 and acme/app#3',
        ['acme/app', 'acme/lib'],
        new Map(),
        () => 'acme/lib',
      ),
    ).toEqual([
      { token: '#12', repository: 'acme/lib', number: 12 },
      { token: 'acme/app#3', repository: 'acme/app', number: 3 },
    ]);
    expect(
      draftReferences('Fix #12', ['acme/app'], new Map(), () => null),
    ).toEqual([]);
  });

  it('qualifies every bare #12 once the repository is chosen', () => {
    expect(bareNumbers('#12, acme/lib#3, #12 and #4 but `#5`')).toEqual([
      12, 4,
    ]);
    expect(
      qualifyReference(
        '#12 and (#12), acme/app#12, #120, `#12`',
        12,
        'acme/lib',
      ),
    ).toBe('acme/lib#12 and (acme/lib#12), acme/app#12, #120, `#12`');
  });

  it('resolves #12 to the repository that has it, or asks', () => {
    const found = (repository: string): DetailState => ({
      status: 'resolved',
      detail: {
        repository,
        number: 12,
        kind: 'pull_request',
        title: `PR in ${repository}`,
        state: 'open',
        draft: false,
        url: '',
        author: null,
        updatedAt: null,
        body: '',
        bodyTruncated: false,
        labels: [],
        comments: 0,
        createdAt: null,
        closedAt: null,
        pull: null,
      },
    });
    const missing: DetailState = { status: 'failed', error: 'Not found' };
    const repositories = ['acme/app', 'acme/lib'];
    expect(
      resolveBare(repositories, [found('acme/app'), { status: 'loading' }]),
    ).toEqual({ status: 'pending' });
    expect(resolveBare(repositories, [missing, found('acme/lib')])).toEqual({
      status: 'resolved',
      repository: 'acme/lib',
    });
    expect(resolveBare(repositories, [missing, missing])).toEqual({
      status: 'resolved',
      repository: 'acme/app',
    });
    const both = resolveBare(repositories, [
      found('acme/app'),
      found('acme/lib'),
    ]);
    expect(both.status).toBe('ambiguous');
    expect(
      both.status === 'ambiguous' &&
        both.candidates.map((candidate) => candidate.repository),
    ).toEqual(repositories);
  });
});
