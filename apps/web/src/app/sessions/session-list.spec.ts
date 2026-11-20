import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
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
    http.expectOne('/api/limits').flush({
      windows: [],
      subscriptionType: null,
      updatedAt: null,
    });
    return fixture;
  };

  it('lists sessions with status, repositories and usage, updated live', async () => {
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
    expect(rows()[0]).toContain('Ready');
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
    // Running comes after the ready session, before the recent ones.
    expect(rows()[1]).toContain('Older');
    expect(rows()[1]).toContain('Running');
  });

  const rows = (fixture: { nativeElement: unknown }) =>
    [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll(
        '[data-testid="session"]',
      ),
    ].map((row) => row.textContent?.replace(/\s+/g, ' ').trim() ?? '');

  it('shows only sessions that need the user from the "Waiting sessions" shortcut', async () => {
    await TestBed.inject(Router).navigateByUrl('/?waiting=1');
    const fixture = await render();
    http.expectOne('/api/sessions').flush({
      sessions: [
        sessionDto({ id: 's1', title: 'Needs me', waitingFor: 'permission' }),
        sessionDto({ id: 's3', title: 'Setup', waitingFor: 'setup' }),
        // Finished its turn, waits for the next message: not blocked.
        sessionDto({ id: 's4', title: 'Idle', waitingFor: 'message' }),
        sessionDto({
          id: 's2',
          title: 'Busy',
          status: 'running',
          waitingFor: null,
        }),
      ],
    });
    await fixture.whenStable();
    expect(rows(fixture)).toHaveLength(2);
    expect(rows(fixture).join(' ')).toContain('Needs me');
    expect(rows(fixture).join(' ')).toContain('Setup');
    const filter = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="waiting-filter"]',
    ) as HTMLElement;
    expect(filter.getAttribute('aria-pressed')).toBe('true');
    expect(filter.textContent?.replace(/\s+/g, ' ').trim()).toBe('Needs you 2');
    (
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="all-filter"]',
      ) as HTMLElement
    ).click();
    await fixture.whenStable();
    expect(rows(fixture)).toHaveLength(4);
    expect(filter.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the last known list, marked as stale, when offline', async () => {
    saveSessionList(
      [sessionDto({ title: 'Known before' })],
      localStorage,
      new Date('2026-03-01T10:00:00Z'),
    );
    const fixture = await render();
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

  it('sends older "new session" and share links on to /new', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/?share=abc');
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(SessionList);
    fixture.detectChanges();
    expect(navigate).toHaveBeenCalledWith(['/new'], {
      queryParams: { share: 'abc' },
      replaceUrl: true,
    });
    http.expectOne('/api/limits');
  });

  it('groups the sessions by what they need', async () => {
    const fixture = await render();
    http.expectOne('/api/sessions').flush({
      sessions: [
        sessionDto({ id: 's1', title: 'Idle', waitingFor: 'message' }),
        sessionDto({
          id: 's2',
          title: 'Ask',
          waitingFor: 'permission',
          pendingRequests: { kind: 'question', count: 1, questions: 2 },
        }),
        sessionDto({
          id: 's3',
          title: 'Busy',
          status: 'running',
          waitingFor: null,
        }),
        sessionDto({
          id: 's4',
          title: 'Done',
          status: 'finished',
          waitingFor: null,
        }),
      ],
    });
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(
      [...element.querySelectorAll('.group-label')].map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(['Needs you', 'Ready', 'Running', 'Recent']);
    const titles = [
      ...element.querySelectorAll('[data-testid="session"] .title'),
    ].map((title) => title.textContent?.trim());
    expect(titles).toEqual(['Ask', 'Idle', 'Busy', 'Done']);
    // What the session needs, not only that it needs the user.
    expect(rows(fixture)[0]).toContain('2 questions');
  });

  it('highlights what waits for the user and mutes what runs by itself', async () => {
    const fixture = await render();
    http.expectOne('/api/sessions').flush({
      sessions: [
        sessionDto({ id: 's1', title: 'Idle', waitingFor: 'message' }),
        sessionDto({ id: 's2', title: 'Ask', waitingFor: 'permission' }),
        sessionDto({
          id: 's3',
          title: 'Busy',
          status: 'running',
          waitingFor: null,
        }),
        sessionDto({
          id: 's4',
          title: 'CI',
          waitingFor: 'background',
          waitingReason: 'CI of #12',
        }),
      ],
    });
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const state = (title: string) => {
      const row = [...element.querySelectorAll('[data-testid="session"]')].find(
        (candidate) =>
          candidate.querySelector('.title')?.textContent?.trim() === title,
      );
      const status = row?.querySelector('[data-testid="session-status"]');
      const dot = row?.querySelector('app-status-dot');
      return {
        classes: [...(status?.classList ?? [])],
        text: status?.textContent?.trim(),
        dot: [...(dot?.classList ?? [])],
      };
    };
    expect(state('Idle')).toEqual({
      classes: ['status', 'status-waiting'],
      text: 'Ready',
      dot: ['dot-idle'],
    });
    expect(state('Ask').classes).toEqual(['status', 'status-permission']);
    expect(state('Ask').dot).toEqual(['dot-attention']);
    expect(state('Busy')).toEqual({
      classes: ['state'],
      text: 'Running',
      dot: ['dot-running'],
    });
    // What it waits for, as muted text.
    expect(state('CI')).toEqual({
      classes: ['state'],
      text: 'CI of #12',
      dot: ['dot-running'],
    });
  });
});
