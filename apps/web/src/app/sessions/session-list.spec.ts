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

  it('lists sessions with status and usage, updated live', async () => {
    const fixture = await render();
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

  it('starts a session and opens it', async () => {
    const fixture = await render();
    http.expectOne('/api/sessions').flush({ sessions: [] });
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'No sessions yet',
    );

    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const component = fixture.componentInstance as unknown as {
      prompt: string;
      model: string;
      create(): void;
    };
    component.prompt = '  Reply with pong ';
    component.model = 'haiku';
    component.create();

    const request = http.expectOne({ method: 'POST', url: '/api/sessions' });
    expect(request.request.body).toEqual({
      prompt: 'Reply with pong',
      model: 'haiku',
    });
    request.flush(sessionDto({ id: 'new' }));
    expect(navigate).toHaveBeenCalledWith(['/sessions', 'new']);
  });

  it('shows why a session could not be started', async () => {
    const fixture = await render();
    http.expectOne('/api/sessions').flush({ sessions: [] });
    const component = fixture.componentInstance as unknown as {
      prompt: string;
      create(): void;
    };
    component.prompt = 'x';
    component.create();
    http
      .expectOne({ method: 'POST', url: '/api/sessions' })
      .flush(
        { message: 'model is not a valid model name' },
        { status: 400, statusText: 'Bad Request' },
      );
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'model is not a valid model name',
    );
  });
});
