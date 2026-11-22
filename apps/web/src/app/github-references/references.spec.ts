import type { MessageReference } from '@claude-remote-manager/shared-types';
import { TestBed } from '@angular/core/testing';
import { MessageText, messageSegments } from './message-text';
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

  it('names the repository of #12 in a chip when there are several', async () => {
    const fixture = TestBed.createComponent(MessageText);
    fixture.componentRef.setInput('text', 'Fix #12 and acme/lib#3');
    fixture.componentRef.setInput('references', [
      reference('#12', 12),
      reference('acme/lib#3', 3),
    ]);
    const tokens = () =>
      [
        ...(fixture.nativeElement as HTMLElement).querySelectorAll(
          '[data-testid="reference-token"]',
        ),
      ].map((token) => token.textContent);
    await fixture.whenStable();
    expect(tokens()).toEqual(['#12', 'acme/lib#3']);
    fixture.componentRef.setInput('showRepository', true);
    await fixture.whenStable();
    expect(tokens()).toEqual(['app#12', 'acme/lib#3']);
  });

  it('keeps the lines of HTML and takes references out of links', async () => {
    const fixture = TestBed.createComponent(MessageText);
    fixture.componentRef.setInput(
      'text',
      '<div>\n  <span>x</span>\n</div>\n\nSee [this](#12)',
    );
    fixture.componentRef.setInput('references', [reference('#12', 12)]);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const first = element.querySelector('p') as HTMLElement;
    expect(first.querySelectorAll('br')).toHaveLength(2);
    expect(first.textContent).toBe('<div>  <span>x</span></div>');
    expect(element.querySelector('a')?.getAttribute('href')).toBe('#12');
    expect(
      element.querySelector('a [data-testid="reference-token"]'),
    ).toBeNull();
    expect(
      [...element.querySelectorAll('[data-testid="reference-token"]')].map(
        (token) => token.textContent,
      ),
    ).toEqual(['#12']);
  });

  it('renders a sent message as Markdown with its chips in place', async () => {
    const fixture = TestBed.createComponent(MessageText);
    fixture.componentRef.setInput(
      'text',
      'Fix **#12** first\n\n* [x] done\n\n- then `x`\n- add a <button> to the <b>page</b>\nnext line',
    );
    fixture.componentRef.setInput('references', [
      reference('#12', 12),
      reference('#9', 9),
    ]);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    // The chip inside the bold text, where #12 was written.
    expect(
      element.querySelector('strong [data-testid="reference-token"]')
        ?.textContent,
    ).toBe('#12');
    expect(element.querySelectorAll('ul')).toHaveLength(2);
    expect(element.querySelector('li code')?.textContent).toBe('x');
    // Task boxes as characters (the sanitizer drops inputs).
    expect(element.querySelector('li')?.textContent).toBe('☑ done');
    // HTML shows as typed; a typed line break stays.
    expect(
      element.querySelector('button:not([data-testid="reference-chip"]), b'),
    ).toBeNull();
    expect(element.querySelectorAll('li')[2].textContent).toBe(
      'add a <button> to the <b>page</b>next line',
    );
    expect(element.querySelector('li br')).not.toBeNull();
    // A reference the text does not contain follows it.
    const tokens = [
      ...element.querySelectorAll('[data-testid="reference-token"]'),
    ].map((token) => token.textContent);
    expect(tokens).toEqual(['#12', '#9']);

    // The other one in a paragraph of its own.
    expect(element.lastElementChild?.tagName).toBe('P');
    expect(element.lastElementChild?.textContent).toContain('#9');

    // A new text replaces the chips.
    fixture.componentRef.setInput('text', 'Plain');
    fixture.componentRef.setInput('references', []);
    await fixture.whenStable();
    expect(element.querySelector('[data-testid="reference-token"]')).toBeNull();
    expect(element.textContent).toBe('Plain');
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
    const text = '#12 and (#12), acme/app#12, #120, `#12`';
    expect(qualifyReference(text, 12, 'acme/lib', 9)).toEqual({
      text: 'acme/lib#12 and (acme/lib#12), acme/app#12, #120, `#12`',
      // The caret after "(" moves with the first #12 only.
      caret: 9 + 'acme/lib'.length,
    });
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
