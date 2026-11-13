import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { SHARE_CACHE, storeShare } from '../../sw/share-store';
import { SessionList } from './session-list';
import { SESSION_LIST_KEY, saveSessionList } from './session-list-cache';
import { WEBSOCKET_FACTORY } from './session-socket';
import { FakeWebSocket, fakeWebSocketFactory } from './testing/fake-websocket';
import { sessionDto } from './testing/session-dto';

describe('SessionList', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    FakeWebSocket.instances = [];
    localStorage.removeItem(SESSION_LIST_KEY);
    await TestBed.configureTestingModule({
      imports: [SessionList],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: WEBSOCKET_FACTORY, useValue: fakeWebSocketFactory },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const render = async () => {
    const fixture = TestBed.createComponent(SessionList);
    fixture.detectChanges();
    http
      .expectOne('/api/models')
      .flush({ models: [], source: 'fallback', updatedAt: null });
    return fixture;
  };

  it('lists sessions with status, repositories and usage, updated live', async () => {
    const fixture = await render();
    http.expectOne('/api/repositories').flush({
      repositories: [],
      strayDirectories: [],
    });
    http.expectOne('/api/sessions').flush({
      sessions: [
        sessionDto(),
        sessionDto({
          id: 's2',
          title: 'Older',
          updatedAt: '2025-12-01T00:00:00.000Z',
          status: 'finished',
        }),
      ],
    });
    await fixture.whenStable();

    const element = fixture.nativeElement as HTMLElement;
    const rows = () =>
      [...element.querySelectorAll('[data-testid="session"]')].map((row) =>
        row.textContent?.replace(/\s+/g, ' ').trim(),
      );
    expect(rows()[0]).toContain('Reply with pong');
    expect(rows()[0]).toContain('Waiting');
    expect(rows()[0]).toContain('acme/app');
    expect(rows()[0]).toContain('1.5k tokens · $0.01');
    expect(rows()[1]).toContain('Finished');

    FakeWebSocket.last.open();
    FakeWebSocket.last.receive({
      type: 'session.updated',
      session: sessionDto({
        id: 's2',
        title: 'Older',
        status: 'running',
        updatedAt: '2026-02-01T00:00:00.000Z',
      }),
    });
    await fixture.whenStable();
    expect(rows()[0]).toContain('Older');
    expect(rows()[0]).toContain('Running');
  });

  it('opens a session started with the form', async () => {
    const fixture = await render();
    http.expectOne('/api/sessions').flush({ sessions: [] });
    http.expectOne('/api/repositories').flush({
      repositories: [],
      strayDirectories: [],
    });
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'No sessions yet',
    );

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
    const element = fixture.nativeElement as HTMLElement;
    expect(
      element.querySelector('[data-testid="session"]')?.textContent,
    ).toContain('Preparing');
  });

  const rows = (fixture: { nativeElement: unknown }) =>
    [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll(
        '[data-testid="session"]',
      ),
    ].map((row) => row.textContent?.replace(/\s+/g, ' ').trim() ?? '');

  it('shows only waiting sessions from the "Waiting sessions" shortcut', async () => {
    await TestBed.inject(Router).navigateByUrl('/?waiting=1');
    const fixture = await render();
    http.expectOne('/api/repositories').flush({
      repositories: [],
      strayDirectories: [],
    });
    http.expectOne('/api/sessions').flush({
      sessions: [
        sessionDto({ id: 's1', title: 'Needs me' }),
        sessionDto({
          id: 's2',
          title: 'Busy',
          status: 'running',
          waitingFor: null,
        }),
      ],
    });
    await fixture.whenStable();
    expect(rows(fixture)).toHaveLength(1);
    expect(rows(fixture)[0]).toContain('Needs me');
    const filter = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="waiting-filter"]',
    ) as HTMLElement;
    expect(filter.textContent?.trim()).toBe('Show all');
    filter.click();
    await fixture.whenStable();
    expect(rows(fixture)).toHaveLength(2);
  });

  it('shows the last known list, marked as stale, when offline', async () => {
    saveSessionList(
      [sessionDto({ title: 'Known before' })],
      localStorage,
      new Date('2026-03-01T10:00:00Z'),
    );
    const fixture = await render();
    http.expectOne('/api/repositories').flush({
      repositories: [],
      strayDirectories: [],
    });
    http.expectOne('/api/sessions').error(new ProgressEvent('error'));
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(
      element.querySelector('[data-testid="stale-list"]')?.textContent,
    ).toContain('Offline: the sessions as of');
    expect(rows(fixture)[0]).toContain('Known before');

    // Back online: the real list replaces it.
    FakeWebSocket.last.open();
    http.expectOne('/api/sessions').flush({
      sessions: [sessionDto({ title: 'Current' })],
    });
    await fixture.whenStable();
    expect(element.querySelector('[data-testid="stale-list"]')).toBeNull();
    expect(rows(fixture)[0]).toContain('Current');
    expect(localStorage.getItem(SESSION_LIST_KEY)).toContain('Current');
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
    await TestBed.inject(Router).navigateByUrl('/?share=abc');
    const fixture = await render();
    http.expectOne('/api/repositories').flush({
      repositories: [],
      strayDirectories: [],
    });
    http.expectOne('/api/sessions').flush({ sessions: [] });
    await fixture.whenStable();
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
