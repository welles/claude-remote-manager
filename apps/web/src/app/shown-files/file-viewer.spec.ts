import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import type { ShownFileDto } from '@claude-remote-manager/shared-types';
import { FileViewer } from './file-viewer';
import { ShownFileCard } from './shown-file-card';
import { shownFile } from './testing/shown-file';

const ID = '11111111-2222-4333-8444-555555555555';

describe('FileViewer', () => {
  let fixture: ComponentFixture<FileViewer>;
  let http: HttpTestingController;
  let closed = 0;

  const render = async (file: ShownFileDto) => {
    TestBed.configureTestingModule({
      imports: [FileViewer],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(FileViewer);
    fixture.componentRef.setInput('file', file);
    closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await fixture.whenStable();
    }
  };

  afterEach(() => http.verify());

  it('renders HTML only in a sandboxed frame of its own origin', async () => {
    const element = await render(
      shownFile({ kind: 'html', name: 'page.html', mediaType: 'text/html' }),
    );
    const frame = element.querySelector(
      '[data-testid="html-frame"]',
    ) as HTMLIFrameElement;
    // Scripts, but no same-origin access, no top navigation, no pop-ups.
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe(`/api/shown-files/${ID}/content`);
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('renders Markdown sanitized', async () => {
    const element = await render(shownFile());
    http
      .expectOne(`/api/shown-files/${ID}/content`)
      .flush(
        '# Report\n\n<img src=x onerror="alert(1)"><script>alert(2)</script>',
      );
    await settle();
    const markdown = element.querySelector('[data-testid="markdown"]');
    expect(markdown?.querySelector('h1')?.textContent).toBe('Report');
    expect(markdown?.querySelector('script')).toBeNull();
    expect(markdown?.querySelector('img')?.getAttribute('onerror')).toBeNull();
  });

  it('highlights code', async () => {
    const element = await render(
      shownFile({ kind: 'text', name: 'a.ts', language: 'typescript' }),
    );
    http.expectOne(`/api/shown-files/${ID}/content`).flush('const a = "<b>";');
    await settle();
    const code = element.querySelector('[data-testid="code"]');
    expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(code?.textContent).toBe('const a = "<b>";');
    expect(code?.querySelector('b')).toBeNull();
  });

  it('embeds PDFs, shows images and offers other files for download', async () => {
    let element = await render(shownFile({ kind: 'pdf', name: 'a.pdf' }));
    expect(
      element.querySelector('[data-testid="pdf-frame"]')?.getAttribute('src'),
    ).toBe(`/api/shown-files/${ID}/content`);
    TestBed.resetTestingModule();
    element = await render(
      shownFile({ kind: 'binary', name: 'a.bin', snapshot: false }),
    );
    expect(element.querySelector('[data-testid="binary"]')).not.toBeNull();
    expect(element.querySelector('[data-testid="live-note"]')).not.toBeNull();
    expect(
      element.querySelector('[data-testid="download"]')?.getAttribute('href'),
    ).toBe(`/api/shown-files/${ID}/live?download=1`);
    (
      element.querySelector('[data-testid="close-viewer"]') as HTMLButtonElement
    ).click();
    expect(closed).toBe(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closed).toBe(2);
  });
});

describe('ShownFileCard', () => {
  it('shows images as thumbnails and other files as cards', async () => {
    TestBed.configureTestingModule({ imports: [ShownFileCard] });
    const fixture = TestBed.createComponent(ShownFileCard);
    const opened: ShownFileDto[] = [];
    fixture.componentInstance.open.subscribe((file) => opened.push(file));
    const image = shownFile({
      kind: 'image',
      name: 'shot.png',
      caption: 'Login page',
    });
    fixture.componentRef.setInput('file', image);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('img')?.getAttribute('src')).toBe(
      `/api/shown-files/${ID}/content`,
    );
    expect(element.textContent).toContain('Login page');
    (
      element.querySelector('[data-testid="shown-image"]') as HTMLButtonElement
    ).click();
    fixture.componentRef.setInput('file', shownFile());
    await fixture.whenStable();
    expect(element.querySelector('img')).toBeNull();
    expect(element.textContent).toContain('Markdown · 1.2 kB');
    (
      element.querySelector('[data-testid="open-file"]') as HTMLButtonElement
    ).click();
    expect(opened.map((file) => file.name)).toEqual(['shot.png', 'report.md']);
  });
});
