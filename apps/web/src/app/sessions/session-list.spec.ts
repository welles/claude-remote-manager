import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { SessionList } from './session-list';
import { WEBSOCKET_FACTORY } from './session-socket';
import { FakeWebSocket, fakeWebSocketFactory } from './testing/fake-websocket';
import { sessionDto } from './testing/session-dto';

describe('SessionList', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    FakeWebSocket.instances = [];
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
});
