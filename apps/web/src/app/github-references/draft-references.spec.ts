import { Injector, runInInjectionContext, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { GitHubReferenceDetail } from '@claude-remote-manager/shared-types';
import { DraftReferences } from './draft-references';
import {
  ReferenceDetails,
  type DetailState,
  type ReferenceOptions,
} from './references';

const detail = (repository: string, number: number): GitHubReferenceDetail => ({
  repository,
  number,
  kind: 'pull_request',
  title: `PR ${number} of ${repository}`,
  state: 'open',
  draft: false,
  url: `https://github.com/${repository}/pull/${number}`,
  author: null,
  updatedAt: null,
  body: '',
  bodyTruncated: false,
  labels: [],
  comments: 0,
  createdAt: null,
  closedAt: null,
  pull: null,
});

describe('DraftReferences', () => {
  /** What GitHub has, by `owner/repo#12`; others are not found. */
  let existing: Set<string>;
  let states: Map<string, ReturnType<typeof signal<DetailState>>>;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
      ],
    });
    existing = new Set();
    states = new Map();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ReferenceDetails,
          useValue: {
            get: (repository: string, number: number) => {
              const key = `${repository}#${number}`;
              let state = states.get(key);
              if (!state) {
                state = signal<DetailState>({ status: 'loading' });
                states.set(key, state);
              }
              return state;
            },
          },
        },
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  /** Answers every lookup asked so far. */
  const answer = () => {
    for (const [key, state] of states) {
      const [repository, number] = key.split('#');
      state.set(
        existing.has(key)
          ? { status: 'resolved', detail: detail(repository, Number(number)) }
          : { status: 'failed', error: 'Not found' },
      );
    }
  };

  const create = (repositories: string[], offered = false) => {
    const text = signal('');
    const options = signal<ReadonlyMap<string, ReferenceOptions>>(new Map());
    const references = runInInjectionContext(TestBed.inject(Injector), () => {
      return new DraftReferences(
        text,
        () => repositories,
        options,
        () => offered,
      );
    });
    const type = (value: string) => {
      text.set(value);
      TestBed.tick();
      vi.advanceTimersByTime(400);
      TestBed.tick();
      // The chips read the entries, which looks the references up.
      references.entries();
    };
    return { references, type, text };
  };

  it('does not ask about a #12 of an offered text and leaves it out', () => {
    existing = new Set(['acme/app#12', 'acme/lib#12', 'acme/lib#7']);
    const { references, type } = create(['acme/app', 'acme/lib'], true);
    type('Fix #12 like #7');
    answer();
    expect(references.unresolved()).toBe(false);
    expect(references.entries().map((entry) => entry.kind)).toEqual(['chip']);
    expect(references.requests('Fix #12 like #7')).toEqual([
      { token: '#7', repository: 'acme/lib', number: 7 },
    ]);
  });

  it('treats further clones of one repository as that one', () => {
    existing = new Set(['acme/app#12']);
    const { references, type } = create(['acme/app', 'acme/app', 'acme/app']);
    type('Check #12');
    answer();
    expect(references.unresolved()).toBe(false);
    expect(references.requests('Check #12')).toEqual([
      { token: '#12', repository: 'acme/app', number: 12 },
    ]);
  });

  it('asks which repository a #12 several repositories have means', () => {
    existing = new Set(['acme/app#12', 'acme/lib#12', 'acme/lib#7']);
    const { references, type } = create(['acme/app', 'acme/lib']);
    type('Fix #12 like #7');
    // Still looking it up: the message waits.
    expect(references.unresolved()).toBe(true);
    answer();
    expect(references.unresolved()).toBe(true);
    const entries = references.entries();
    expect(entries.map((entry) => entry.kind)).toEqual(['ambiguous', 'chip']);
    const [ambiguous, chip] = entries;
    expect(
      ambiguous.kind === 'ambiguous' &&
        ambiguous.candidates.map((candidate) => candidate.repository),
    ).toEqual(['acme/app', 'acme/lib']);
    // #7 is only in the second repository.
    expect(chip.kind === 'chip' && chip.chip.repository).toBe('acme/lib');

    type('Fix acme/lib#12 like #7');
    answer();
    expect(references.unresolved()).toBe(false);
    expect(references.requests('Fix acme/lib#12 like #7')).toEqual([
      { token: 'acme/lib#12', repository: 'acme/lib', number: 12 },
      { token: '#7', repository: 'acme/lib', number: 7 },
    ]);
  });

  it('reads #12 as the first repository when none has it', () => {
    const { references, type } = create(['acme/app', 'acme/lib']);
    type('Fix #3');
    answer();
    expect(references.unresolved()).toBe(false);
    expect(references.requests('Fix #3')).toEqual([
      { token: '#3', repository: 'acme/app', number: 3 },
    ]);
  });

  it('reads #12 as the repository that answered when another could not', () => {
    existing = new Set(['acme/lib#5']);
    const { references, type } = create(['acme/app', 'acme/lib']);
    type('Fix #5');
    states
      .get('acme/app#5')
      ?.set({ status: 'failed', error: 'GitHub is not reachable' });
    answer();
    expect(references.requests('Fix #5')).toEqual([
      { token: '#5', repository: 'acme/lib', number: 5 },
    ]);
  });

  it('waits only for a #12 typed since the text settled', () => {
    const { references, type, text } = create(['acme/app', 'acme/lib']);
    type('Fix #3');
    answer();
    expect(references.unresolved()).toBe(false);
    // More words: #3 is known, sending stays possible.
    text.set('Fix #3 now');
    expect(references.unresolved()).toBe(false);
    // A new number: not known before typing pauses.
    text.set('Fix #3 and #4');
    expect(references.unresolved()).toBe(true);
    type('Fix #3 and #4');
    answer();
    expect(references.unresolved()).toBe(false);
  });

  it('only asks about references that are sent', () => {
    existing = new Set(['acme/app#12', 'acme/lib#12']);
    const { references, type } = create(['acme/app', 'acme/lib']);
    const named = Array.from({ length: 10 }, (_, i) => `acme/app#${i + 1}`);
    type(`${named.join(' ')} and #12`);
    answer();
    // #12 is the eleventh reference: neither sent nor asked about.
    expect(references.unresolved()).toBe(false);
    expect(references.entries()).toHaveLength(10);
    expect(references.entries().every((entry) => entry.kind === 'chip')).toBe(
      true,
    );
  });

  it('looks up a #12 that moves into the sent references', () => {
    existing = new Set(['acme/lib#7', 'acme/lib#20']);
    const { references, type } = create(['acme/app', 'acme/lib']);
    const named = Array.from({ length: 8 }, (_, i) => `acme/app#${i + 1}`);
    // #7 becomes acme/lib#7, so #20 is the tenth reference.
    const text = `${named.join(' ')} #7 acme/lib#7 #20`;
    type(text);
    answer();
    expect(references.unresolved()).toBe(false);
    expect(references.requests(text).slice(-2)).toEqual([
      { token: '#7', repository: 'acme/lib', number: 7 },
      { token: '#20', repository: 'acme/lib', number: 20 },
    ]);
  });

  it('shows a #12 being looked up without a repository', () => {
    const { references, type } = create(['acme/app', 'acme/lib']);
    type('Fix #3');
    const [entry] = references.entries();
    expect(entry.kind === 'chip' && entry.pending).toBe(true);
  });

  it('reads #12 as the only repository without asking GitHub first', () => {
    const { references, type } = create(['acme/app']);
    type('Fix #12');
    expect(references.unresolved()).toBe(false);
    expect(references.requests('Fix #12')).toEqual([
      { token: '#12', repository: 'acme/app', number: 12 },
    ]);
  });
});
