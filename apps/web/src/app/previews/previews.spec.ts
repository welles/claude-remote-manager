import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  PREVIEW_FRAME_SANDBOX,
  type PreviewDto,
} from '@claude-remote-manager/shared-types';
import { PreviewCard } from './preview-card';
import { PreviewFrame } from './preview-frame';
import { currentPreview } from './previews-api';
import { preview, PREVIEW_ID } from './testing/preview';

describe('PreviewCard', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [PreviewCard],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });

  const render = async (value: PreviewDto) => {
    const fixture = TestBed.createComponent(PreviewCard);
    fixture.componentRef.setInput('preview', value);
    await fixture.whenStable();
    return { fixture, element: fixture.nativeElement as HTMLElement };
  };

  it('links a running preview without opener and referrer', async () => {
    const { element } = await render(preview());
    const link = element.querySelector(
      '[data-testid="preview-link"]',
    ) as HTMLAnchorElement;
    expect(link.href).toBe('https://demo-abc123-5173.preview.example.com/');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(element.textContent).toContain('Running · port 5173');
  });

  it('shows why a preview is not reachable, and no actions once stopped', async () => {
    const { fixture, element } = await render(
      preview({
        state: 'unreachable',
        problem: 'Nothing listens on port 5173',
      }),
    );
    expect(element.textContent).toContain('Not reachable');
    expect(element.textContent).toContain('Nothing listens on port 5173');
    fixture.componentRef.setInput('preview', preview({ state: 'stopped' }));
    await fixture.whenStable();
    expect(element.querySelector('[data-testid="preview-link"]')).toBeNull();
    expect(element.querySelector('[data-testid="preview-stop"]')).toBeNull();
    expect(element.querySelector('[data-testid="preview-embed"]')).toBeNull();
  });

  it('never links anything but http(s)', async () => {
    const { element } = await render(preview({ url: 'javascript:alert(1)' }));
    expect(element.querySelector('a')).toBeNull();
  });

  it('stops the preview and embeds it on request', async () => {
    const { fixture, element } = await render(preview());
    const embedded: PreviewDto[] = [];
    fixture.componentInstance.embed.subscribe((value) => embedded.push(value));
    (
      element.querySelector(
        '[data-testid="preview-embed"]',
      ) as HTMLButtonElement
    ).click();
    expect(embedded.map((value) => value.id)).toEqual([PREVIEW_ID]);
    (
      element.querySelector('[data-testid="preview-stop"]') as HTMLButtonElement
    ).click();
    const http = TestBed.inject(HttpTestingController);
    const request = http.expectOne(
      `/api/sessions/s1/previews/${PREVIEW_ID}/stop`,
    );
    expect(request.request.method).toBe('POST');
    request.flush(preview({ state: 'stopped' }));
    http.verify();
  });
});

describe('PreviewFrame', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [PreviewFrame] });
  });

  it('frames the preview sandboxed, without referrer or top navigation', async () => {
    const fixture = TestBed.createComponent(PreviewFrame);
    fixture.componentRef.setInput('preview', preview());
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const frame = element.querySelector(
      '[data-testid="preview-frame"]',
    ) as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe(
      'https://demo-abc123-5173.preview.example.com/',
    );
    expect(frame.getAttribute('sandbox')).toBe(PREVIEW_FRAME_SANDBOX);
    expect(PREVIEW_FRAME_SANDBOX).not.toContain('top-navigation');
    expect(PREVIEW_FRAME_SANDBOX).not.toContain('escape-sandbox');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('allow')).toBe('');

    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closed).toBe(1);

    fixture.componentRef.setInput('preview', preview({ state: 'stopped' }));
    await fixture.whenStable();
    expect(element.querySelector('iframe')).toBeNull();
    expect(element.textContent).toContain('This preview was stopped');
  });

  it('frames nothing that is not http(s)', async () => {
    const fixture = TestBed.createComponent(PreviewFrame);
    fixture.componentRef.setInput(
      'preview',
      preview({ url: 'javascript:alert(1)' }),
    );
    await fixture.whenStable();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('iframe'),
    ).toBeNull();
  });
});

describe('currentPreview', () => {
  it('takes the session’s state, or stopped when it is gone', () => {
    const old = preview({ state: 'running' });
    expect(currentPreview(old, [preview({ state: 'unreachable' })]).state).toBe(
      'unreachable',
    );
    expect(currentPreview(old, [])).toMatchObject({
      state: 'stopped',
      problem: null,
    });
  });
});
