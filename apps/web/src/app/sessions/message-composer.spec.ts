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
    expect(sent).toEqual([{ id: null, text: '', attachmentIds: ['a1'] }]);
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
    expect(sent).toEqual([{ id: null, text: 'Look', attachmentIds: ['a2'] }]);
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
    expect(sent).toEqual([{ id: 'm1', text: 'Again', attachmentIds: ['a1'] }]);
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
    const key = (name: string) =>
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, cancelable: true }),
      );
    key('ArrowDown');
    key('Enter');
    await fixture.whenStable();
    expect(textarea.value).toBe('Look at @"/w/acme/lib/docs/log book.md" ');
    expect(element.querySelector('[data-testid="mentions"]')).toBeNull();
    // Enter sent nothing.
    expect(sent).toEqual([]);

    // Without "@" before the caret: no request.
    await type('plain text');
    http.expectNone('/api/sessions/s1/files');
  });
});
