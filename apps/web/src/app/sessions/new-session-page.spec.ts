import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { SHARE_CACHE, storeShare } from '../../sw/share-store';
import { NewSessionPage } from './new-session-page';
import { WEBSOCKET_FACTORY } from './session-socket';
import { fakeWebSocketFactory } from './testing/fake-websocket';
import { sessionDto } from './testing/session-dto';

describe('NewSessionPage', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NewSessionPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: '**', children: [] }]),
        { provide: WEBSOCKET_FACTORY, useValue: fakeWebSocketFactory },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const render = async () => {
    const fixture = TestBed.createComponent(NewSessionPage);
    fixture.detectChanges();
    http
      .expectOne('/api/models')
      .flush({ models: [], source: 'fallback', updatedAt: null });
    http.expectOne('/api/repositories').flush({
      repositories: [],
      strayDirectories: [],
    });
    await fixture.whenStable();
    return fixture;
  };

  it('opens a session started with the form', async () => {
    const fixture = await render();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const form = fixture.debugElement.query(
      (node) => node.name === 'app-new-session-form',
    );
    (
      form.componentInstance as { created: { emit(s: unknown): void } }
    ).created.emit(sessionDto({ id: 'new', status: 'preparing' }));
    await fixture.whenStable();
    expect(navigate).toHaveBeenCalledWith(['/sessions', 'new']);
  });

  it('fills the form with content shared to the app', async () => {
    const store = new Map<string, Response>();
    const cache = {
      put: async (key: string, response: Response) =>
        void store.set(key, response),
      match: async (key: string) => store.get(key)?.clone(),
      delete: async (key: string) => store.delete(key),
      keys: async () => [...store.keys()].map((url) => ({ url })),
    };
    vi.stubGlobal('caches', {
      open: async (name: string) => (name === SHARE_CACHE ? cache : null),
    });
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    await storeShare(cache, 'abc', {
      title: '',
      text: 'The login fails',
      url: 'https://example.com/1',
      files: [new File(['png'], 'shot.png', { type: 'image/png' })],
    });
    await TestBed.inject(Router).navigateByUrl('/new?share=abc');
    const fixture = await render();
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(
      (
        element.querySelector(
          '[data-testid="new-prompt"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe('The login fails\n\nhttps://example.com/1');
    expect(
      element.querySelector('[data-testid="share-notice"]'),
    ).not.toBeNull();
    expect(store.size).toBe(0);
    // The image is uploaded once, like an attached one.
    http
      .expectOne({ method: 'POST', url: '/api/attachments' })
      .flush({ id: 'a1', name: 'shot.png', mediaType: 'image/png', size: 3 });
    vi.unstubAllGlobals();
  });
});
