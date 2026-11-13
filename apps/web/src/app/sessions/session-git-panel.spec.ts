import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type {
  PullRequestDto,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { words } from '../testing/text';
import { SessionGitPanel } from './session-git-panel';
import { sessionDto } from './testing/session-dto';

const pull = (overrides: Partial<PullRequestDto> = {}): PullRequestDto => ({
  id: 1,
  repositoryId: 'r1',
  repository: 'acme/app',
  number: 7,
  url: 'https://github.com/acme/app/pull/7',
  title: 'Fix login',
  state: 'open',
  draft: false,
  headBranch: 'claude/reply-with-pong-abc123',
  baseBranch: 'main',
  createdBy: 'claude',
  openedAt: '2026-01-01T10:00:00.000Z',
  closedAt: null,
  mergedAt: null,
  syncedAt: '2026-01-01T10:00:00.000Z',
  ...overrides,
});

const githubSession = (overrides: Partial<SessionDto> = {}) => {
  const base = sessionDto();
  return sessionDto({
    directories: [
      {
        ...base.directories[0],
        repository: {
          id: 'r1',
          fullName: 'acme/app',
          local: false,
          github: true,
        },
      },
      {
        ...base.directories[0],
        role: 'additional',
        path: '/workspace/sessions/x/local/tool',
        repository: {
          id: 'r2',
          fullName: 'local/tool',
          local: true,
          github: false,
        },
      },
    ],
    ...overrides,
  });
};

describe('SessionGitPanel', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionGitPanel],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  const render = async (session: SessionDto) => {
    const fixture = TestBed.createComponent(SessionGitPanel);
    fixture.componentRef.setInput('session', session);
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const all = (testId: string) =>
      [...element.querySelectorAll(`[data-testid="${testId}"]`)].map((node) =>
        words(node),
      );
    const click = async (testId: string) => {
      (
        element.querySelector(`[data-testid="${testId}"]`) as HTMLElement
      ).click();
      fixture.detectChanges();
      await fixture.whenStable();
    };
    return { fixture, element, all, click };
  };

  it('offers push and pull requests for repositories with a remote and lists the pull requests', async () => {
    const { all } = await render(
      githubSession({
        pullRequests: [
          pull(),
          pull({
            id: 2,
            number: 3,
            title: 'Old',
            state: 'merged',
            createdBy: 'user',
          }),
        ],
      }),
    );
    expect(all('git-clone')).toHaveLength(1);
    expect(all('push')).toEqual(['Push']);
    expect(all('create-pr')).toEqual(['Create PR']);
    expect(all('pull-request')).toEqual([
      'Open #7 Fix login by Claude',
      'Merged #3 Old',
    ]);
  });

  it('pushes by button and shows the outcome', async () => {
    const { fixture, all, click } = await render(githubSession());
    await click('push');
    const request = http.expectOne({
      method: 'POST',
      url: '/api/sessions/s1/repositories/r1/push',
    });
    request.flush(githubSession());
    fixture.detectChanges();
    expect(all('git-message')).toEqual([
      'Pushed claude/reply-with-pong-abc123',
    ]);
  });

  it('creates a pull request with title, body and base', async () => {
    const { fixture, element, all, click } = await render(githubSession());
    await click('create-pr');
    const body = element.querySelector(
      '[data-testid="pr-body"]',
    ) as HTMLTextAreaElement;
    body.value = 'Details';
    body.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(all('pr-submit')).toEqual(['Push and create pull request']);
    await click('pr-submit');
    const request = http.expectOne({
      method: 'POST',
      url: '/api/sessions/s1/repositories/r1/pull-requests',
    });
    expect(request.request.body).toEqual({
      title: 'Reply with pong',
      body: 'Details',
      base: 'main',
      draft: false,
    });
    request.flush(pull());
    fixture.detectChanges();
    expect(all('git-message')).toEqual(['Pull request #7 is open']);
    expect(all('pr-form')).toEqual([]);
  });

  it('shows errors of the API', async () => {
    const { fixture, all, click } = await render(githubSession());
    await click('push');
    http.expectOne('/api/sessions/s1/repositories/r1/push').flush(
      {
        message:
          'The remote branch has commits the session clone does not have',
      },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();
    expect(all('git-message')[0]).toContain('remote branch has commits');
  });

  it('shows nothing for sessions without remote repositories', async () => {
    const { element } = await render(sessionDto({ directories: [] }));
    expect(element.querySelector('[data-testid="git-panel"]')).toBeNull();
  });
});
