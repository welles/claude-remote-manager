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

  const create = (repositories: string[]) => {
    const text = signal('');
    const options = signal<ReadonlyMap<string, ReferenceOptions>>(new Map());
    const references = runInInjectionContext(TestBed.inject(Injector), () => {
      return new DraftReferences(text, () => repositories, options);
    });
    const type = (value: string) => {
      text.set(value);
      TestBed.tick();
      vi.advanceTimersByTime(400);
      TestBed.tick();
      // The chips read the entries, which looks the references up.
      references.entries();
    };
    return { references, type };
  };

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

  it('waits for typing to pause before the references are known', () => {
    const { references, type } = create(['acme/app', 'acme/lib']);
    type('Fix #3');
    answer();
    expect(references.unresolved()).toBe(false);
    expect(references.requests('Fix #3')).toEqual([
      { token: '#3', repository: 'acme/app', number: 3 },
    ]);
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
