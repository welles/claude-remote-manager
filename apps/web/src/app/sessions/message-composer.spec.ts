import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { words } from '../testing/text';
import { MessageComposer, type ComposedMessage } from './message-composer';

const png = (name = 'shot.png') =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, {
    type: 'image/png',
  });

describe('MessageComposer', () => {
  let fixture: ComponentFixture<MessageComposer>;
  let http: HttpTestingController;
  let sent: ComposedMessage[];
  let element: HTMLElement;

  beforeEach(async () => {
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    TestBed.configureTestingModule({
      imports: [MessageComposer],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MessageComposer);
    sent = [];
    fixture.componentInstance.send.subscribe((message) => sent.push(message));
    await fixture.whenStable();
    element = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => http.verify());

  const button = (testId: string) =>
    element.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement;
  const paste = async (...files: File[]) => {
    const event = new Event('paste', { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: files.map((file) => ({
          kind: 'file',
          getAsFile: () => file,
        })),
      },
    });
    element.querySelector('textarea')?.dispatchEvent(event);
    await fixture.whenStable();
    return event;
  };

  it('uploads pasted images and sends them with the message', async () => {
    const event = await paste(png());
    expect(event.defaultPrevented).toBe(true);
    const upload = http.expectOne('/api/attachments');
    expect(upload.request.headers.get('Content-Type')).toBe('image/png');
    expect(upload.request.headers.get('X-File-Name')).toBe('shot.png');
    // While uploading, the message cannot be sent yet.
    expect(button('send').disabled).toBe(true);
    expect(element.textContent).toContain('Uploading');
    upload.flush({
      id: 'a1',
      name: 'shot.png',
      mediaType: 'image/png',
      size: 4,
    });
    await fixture.whenStable();
    expect(button('send').disabled).toBe(false);
    button('send').click();
    expect(sent).toEqual([
      { id: null, text: '', attachmentIds: ['a1'], references: [] },
    ]);
    fixture.componentInstance.clear();
    await fixture.whenStable();
    expect(element.querySelector('[data-testid="draft-image"]')).toBeNull();
  });

  it('lets images be removed and refuses other files', async () => {
    await paste(png('a.png'), png('b.png'));
    const [first, second] = http.match('/api/attachments');
    first.flush({ id: 'a1', name: 'a.png', mediaType: 'image/png', size: 4 });
    second.flush({ id: 'a2', name: 'b.png', mediaType: 'image/png', size: 4 });
    await fixture.whenStable();
    button('remove-image').click();
    await fixture.whenStable();
    expect(
      element.querySelectorAll('[data-testid="draft-image"]'),
    ).toHaveLength(1);

    const picker = element.querySelector(
      '[data-testid="image-picker"]',
    ) as HTMLInputElement;
    const svg = new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' });
    Object.defineProperty(picker, 'files', {
      value: [svg],
      configurable: true,
    });
    picker.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(
      element.querySelector('[data-testid="image-notice"]')?.textContent,
    ).toContain('only PNG, JPEG, GIF and WebP');
    http.expectNone('/api/attachments');

    const textarea = element.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Look';
    textarea.dispatchEvent(new Event('input'));
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }),
    );
    expect(sent).toEqual([
      { id: null, text: 'Look', attachmentIds: ['a2'], references: [] },
    ]);
  });

  it('sends a message that was not sent again under its ID', async () => {
    fixture.componentInstance.restore('m1', 'Again', [
      { id: 'a1', name: 'a.png', mediaType: 'image/png', size: 4 },
    ]);
    await fixture.whenStable();
    expect(
      (
        element.querySelector(
          '[data-testid="draft-image"] img',
        ) as HTMLImageElement
      ).src,
    ).toContain('/api/attachments/a1');
    button('send').click();
    expect(sent).toEqual([
      { id: 'm1', text: 'Again', attachmentIds: ['a1'], references: [] },
    ]);
  });

  it('shows the suggested message as placeholder, to take or send', async () => {
    fixture.componentRef.setInput('suggestion', 'Run the tests');
    await fixture.whenStable();
    const textarea = element.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe('Run the tests');

    // Send with the empty input sends it as it is.
    expect(button('send').disabled).toBe(false);
    button('send').click();
    expect(sent.at(-1)?.text).toBe('Run the tests');

    // Tab puts it into the input to edit.
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    textarea.dispatchEvent(tab);
    await fixture.whenStable();
    expect(tab.defaultPrevented).toBe(true);
    expect(textarea.value).toBe('Run the tests');
    expect(textarea.placeholder).toBe('Message');
    expect(button('take-suggestion')).toBeNull();

    // So does the edit button (touch screens).
    fixture.componentInstance.clear();
    await fixture.whenStable();
    button('take-suggestion').click();
    await fixture.whenStable();
    expect(textarea.value).toBe('Run the tests');

    // Typed text wins over the suggestion.
    textarea.value = 'Something else';
    textarea.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    button('send').click();
    expect(sent.at(-1)?.text).toBe('Something else');

    fixture.componentRef.setInput('suggestion', null);
    fixture.componentInstance.clear();
    await fixture.whenStable();
    const plainTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      cancelable: true,
    });
    textarea.dispatchEvent(plainTab);
    expect(plainTab.defaultPrevented).toBe(false);
    expect(textarea.placeholder).toBe('Message');
    expect(button('send').disabled).toBe(true);
  });

  it('does not send the suggestion instead of an image that failed', async () => {
    fixture.componentRef.setInput('suggestion', 'Run the tests');
    await paste(png());
    http
      .expectOne('/api/attachments')
      .flush('nope', { status: 500, statusText: 'Server Error' });
    await fixture.whenStable();
    const textarea = element.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe('Message');
    expect(button('send').disabled).toBe(true);
  });

  it('completes @ references from the session’s files', async () => {
    fixture.componentRef.setInput('sessionId', 's1');
    fixture.componentRef.setInput('showRepository', true);
    await fixture.whenStable();
    const textarea = element.querySelector('textarea') as HTMLTextAreaElement;
    const type = async (value: string) => {
      textarea.value = value;
      textarea.setSelectionRange(value.length, value.length);
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 200));
    };
    await type('Look at @log');
    http
      .expectOne(
        (request) =>
          request.url === '/api/sessions/s1/files' &&
          request.params.get('query') === 'log',
      )
      .flush({
        files: [
          {
            directory: 0,
            repository: 'acme/app',
            path: 'src/login.ts',
            mention: '@src/login.ts',
          },
          {
            directory: 1,
            repository: 'acme/lib',
            path: 'docs/log book.md',
            mention: '@"/w/acme/lib/docs/log book.md"',
          },
        ],
        truncated: false,
      });
    await fixture.whenStable();
    const options = element.querySelectorAll('[data-testid="mention"]');
    expect([...options].map((option) => words(option))).toEqual([
      'src/login.ts acme/app',
      'docs/log book.md acme/lib',
    ]);
    // The combobox points at the list it controls.
    const list = element.querySelector('[data-testid="mentions"]');
    expect(list?.id).toBeTruthy();
    expect(textarea.getAttribute('aria-controls')).toBe(list?.id);
    const key = (name: string) =>
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, cancelable: true }),
      );
    key('ArrowDown');
    key('Enter');
    await fixture.whenStable();
    expect(textarea.value).toBe('Look at @"/w/acme/lib/docs/log book.md" ');
    expect(element.querySelector('[data-testid="mentions"]')).toBeNull();
    expect(textarea.hasAttribute('aria-controls')).toBe(false);
    // Enter sent nothing.
    expect(sent).toEqual([]);

    // Without "@" before the caret: no request.
    await type('plain text');
    http.expectNone('/api/sessions/s1/files');
  });
  it('completes slash commands at the start of a message', async () => {
    fixture.componentRef.setInput('sessionId', 's1');
    await fixture.whenStable();
    const textarea = element.querySelector('textarea') as HTMLTextAreaElement;
    const type = async (value: string) => {
      textarea.value = value;
      textarea.setSelectionRange(value.length, value.length);
      textarea.dispatchEvent(new Event('input'));
      await fixture.whenStable();
    };
    const command = (name: string, extra: object = {}) => ({
      name,
      description: `${name} it`,
      argumentHint: '',
      aliases: [],
      builtin: false,
      ...extra,
    });
    await type('/re');
    http.expectOne('/api/sessions/s1/slash-commands').flush({
      source: 'session',
      commands: [
        command('compact', { builtin: true }),
        command('review', { argumentHint: '<pr>' }),
        command('pre-review'),
        command('usage', { aliases: ['cost'] }),
      ],
    });
    await fixture.whenStable();
    const names = () =>
      [...element.querySelectorAll('[data-testid="command"] .command-name')].map(
        (option) => words(option),
      );
    // Starting with what was typed first, then containing it.
    expect(names()).toEqual(['/review <pr>', '/pre-review']);
    expect(textarea.getAttribute('aria-controls')).toBe('command-list');
    // Aliases count.
    await type('/co');
    expect(names()).toEqual(['/compact', '/usage']);
    await type('/re');
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }),
    );
    await fixture.whenStable();
    expect(textarea.value).toBe('/review ');
    expect(element.querySelector('[data-testid="commands"]')).toBeNull();
    expect(sent).toEqual([]);

    // Only at the start of the message, before a space.
    await type('Run /re');
    await type('/review now');
    expect(element.querySelector('[data-testid="commands"]')).toBeNull();
    http.expectNone('/api/sessions/s1/slash-commands');
  });

  it('keeps the next line, drops stale lists and stays in range', async () => {
    fixture.componentRef.setInput('sessionId', 's1');
    await fixture.whenStable();
    const textarea = element.querySelector('textarea') as HTMLTextAreaElement;
    const command = (name: string) => ({
      name,
      description: '',
      argumentHint: '',
      aliases: [],
      builtin: false,
    });
    const key = (name: string) =>
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, cancelable: true }),
      );
    // Typing "/re" in front of a second line.
    textarea.value = '/re\nmore';
    textarea.setSelectionRange(3, 3);
    textarea.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    const first = http.expectOne('/api/sessions/s1/slash-commands');
    // The list closes and opens again: a second request.
    textarea.setSelectionRange(0, 0);
    textarea.dispatchEvent(new Event('input'));
    textarea.setSelectionRange(3, 3);
    textarea.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    const second = http.expectOne('/api/sessions/s1/slash-commands');
    second.flush({ source: 'session', commands: [command('review')] });
    // The older answer arrives late: ignored.
    first.flush({
      source: 'user',
      commands: [command('remote'), command('rename'), command('resume')],
    });
    await fixture.whenStable();
    expect(
      [...element.querySelectorAll('[data-testid="command"]')].length,
    ).toBe(1);
    key('ArrowDown');
    key('ArrowDown');
    expect(textarea.getAttribute('aria-activedescendant')).toBe('command-0');
    key('Enter');
    await fixture.whenStable();
    expect(textarea.value).toBe('/review \nmore');
  });

  it('completes # references from GitHub and sends them with the chosen extras', async () => {
    fixture.componentRef.setInput('githubRepositories', [
      'acme/app',
      'acme/lib',
    ]);
    await fixture.whenStable();
    const textarea = element.querySelector('textarea') as HTMLTextAreaElement;
    const type = async (value: string) => {
      textarea.value = value;
      textarea.setSelectionRange(value.length, value.length);
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 200));
    };
    const summary = (repository: string, number: number, title: string) => ({
      repository,
      number,
      kind: number === 3 ? 'pull_request' : 'issue',
      title,
      state: 'open',
      draft: false,
      url: `https://github.com/${repository}/issues/${number}`,
      author: 'bob',
      updatedAt: null,
    });
    await type('Fix #log');
    http
      .expectOne(
        (request) =>
          request.url === '/api/github/references' &&
          request.params.get('query') === 'log' &&
          request.params.get('repositories') === 'acme/app,acme/lib',
      )
      .flush({
        results: [
          summary('acme/app', 12, 'Login fails'),
          summary('acme/lib', 3, 'Log helper'),
        ],
        errors: ['acme/lib: rate limit'],
      });
    await fixture.whenStable();
    const options = element.querySelectorAll(
      '[data-testid="reference-suggestion"]',
    );
    expect([...options].map((option) => words(option))).toEqual([
      '#12 Login fails acme/app Issue',
      '#3 Log helper acme/lib PR',
    ]);
    expect(
      element.querySelector('[data-testid="reference-search-error"]')
        ?.textContent,
    ).toContain('rate limit');
    const key = (name: string) =>
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, cancelable: true }),
      );
    key('Enter');
    await fixture.whenStable();
    // The main repository's issues are written as #12.
    expect(textarea.value).toBe('Fix #12 ');
    await type('Fix #12 and #log');
    http
      .expectOne((request) => request.url === '/api/github/references')
      .flush({ results: [summary('acme/lib', 3, 'Log helper')], errors: [] });
    await fixture.whenStable();
    key('Enter');
    await fixture.whenStable();
    expect(textarea.value).toBe('Fix #12 and acme/lib#3 ');
    expect(sent).toEqual([]);

    // The chips show what the references are.
    await new Promise((resolve) => setTimeout(resolve, 450));
    http.expectOne('/api/github/references/acme/app/12').flush({
      ...summary('acme/app', 12, 'Login fails'),
      body: 'Steps',
      bodyTruncated: false,
      labels: [],
      comments: 2,
      createdAt: null,
      closedAt: null,
      pull: null,
    });
    http
      .expectOne('/api/github/references/acme/lib/3')
      .flush(
        { message: 'Not found' },
        { status: 404, statusText: 'Not Found' },
      );
    await fixture.whenStable();
    const chips = element.querySelectorAll('[data-testid="reference-chip"]');
    expect([...chips].map((chip) => words(chip))).toEqual([
      '#12 Login fails',
      'acme/lib#3 not found',
    ]);

    // Comments for #12, chosen in its preview.
    (chips[0] as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-testid="reference-comments"]'),
      ).not.toBeNull(),
    );
    const comments = document.querySelector(
      '[data-testid="reference-comments"]',
    ) as HTMLInputElement;
    comments.checked = true;
    comments.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(words(chips[0])).toBe('#12 Login fails +comments');
    const link = document.querySelector(
      '[data-testid="reference-link"]',
    ) as HTMLAnchorElement;
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');

    button('send').click();
    expect(sent.at(-1)?.references).toEqual([
      { token: '#12', repository: 'acme/app', number: 12, comments: true },
      { token: 'acme/lib#3', repository: 'acme/lib', number: 3 },
    ]);
  });

  it('offers nothing for # without GitHub repositories', async () => {
    const textarea = element.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Fix #1';
    textarea.setSelectionRange(6, 6);
    textarea.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    http.expectNone((request) => request.url.startsWith('/api/github'));
    button('send').click();
    expect(sent.at(-1)?.references).toEqual([]);
  });
});
