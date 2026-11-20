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
import { Toasts } from '../ui/toasts';
import { SessionGitPanel } from './session-git-panel';
import { pullRequestDto as pull } from './testing/pull-request';
import { sessionDto } from './testing/session-dto';

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
    const { all, element } = await render(
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
    const pulls = all('pull-request');
    expect(pulls[0]).toMatch(
      /^Open #7 Fix login by Claude Autofix Autoclose Automerge/,
    );
    expect(pulls[1]).toBe('Merged #3 Old');
    expect(
      element.querySelector('[data-testid="pull-request-state"]')?.className,
    ).toContain('state-open');
    // The automation is offered for open pull requests only.
    expect(all('pr-automation')).toHaveLength(1);
  });

  it('marks an open draft pull request grey, like GitHub', async () => {
    const { all, element } = await render(
      githubSession({ pullRequests: [pull({ draft: true })] }),
    );
    expect(all('pull-request-state')).toEqual(['Draft']);
    const state = element.querySelector('[data-testid="pull-request-state"]');
    expect(state?.classList).toContain('state-draft');
    expect(state?.classList).not.toContain('state-open');
  });

  it('shows the checks of an open pull request, folded into one line', async () => {
    const { element, all, click } = await render(
      githubSession({
        pullRequests: [
          pull({
            checks: {
              headSha: 'a'.repeat(40),
              readAt: '2026-01-01T10:00:00.000Z',
              checks: [
                {
                  name: 'test',
                  state: 'failure',
                  url: 'https://github.com/acme/app/runs/1',
                },
                { name: 'lint', state: 'pending', url: null },
                { name: 'build', state: 'success', url: null },
                { name: 'review', state: 'neutral', url: null },
              ],
            },
          }),
          pull({
            id: 2,
            number: 8,
            checks: {
              headSha: 'b'.repeat(40),
              readAt: '2026-01-01T10:00:00.000Z',
              checks: [],
            },
          }),
          pull({ id: 3, number: 9 }),
        ],
      }),
    );
    expect(all('pr-checks-summary')).toEqual([
      'Checks: 1 failed, 1 running, 2 passed',
      'No checks reported',
    ]);
    const summary = element.querySelector(
      '[data-testid="pr-checks-summary"]',
    ) as HTMLElement;
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(all('pr-check')).toEqual([]);
    await click('pr-checks-summary');
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(all('pr-check')).toEqual([
      'test failed',
      'lint running',
      'build passed',
      'review neutral',
    ]);
    const link = element.querySelector(
      '[data-testid="pr-check"] a',
    ) as HTMLAnchorElement;
    expect(link.href).toBe('https://github.com/acme/app/runs/1');
  });

  describe('PR automation', () => {
    const automation = (
      overrides: Partial<PullRequestDto['automation']> = {},
    ): PullRequestDto['automation'] => ({
      ...pull().automation,
      ...overrides,
    });

    it('switches autofix and autoclose and shows the attempts', async () => {
      const { fixture, element, all, click } = await render(
        githubSession({
          pullRequests: [pull({ automation: automation({ attempts: 1 }) })],
        }),
      );
      expect(all('autofix-attempts')).toEqual(['Attempts 1 / 3']);
      (
        element.querySelector(
          '[data-testid="autofix-toggle"] button',
        ) as HTMLElement
      ).click();
      const toggle = http.expectOne({
        method: 'PATCH',
        url: '/api/sessions/s1/pull-requests/1/automation',
      });
      expect(toggle.request.body).toEqual({ autofix: true });
      toggle.flush(githubSession());
      fixture.detectChanges();
      await click('autofix-limit-up');
      const limit = http.expectOne(
        '/api/sessions/s1/pull-requests/1/automation',
      );
      expect(limit.request.body).toEqual({ maxAttempts: 4 });
      limit.flush(githubSession());
      fixture.detectChanges();
      await click('autofix-reset');
      const reset = http.expectOne(
        '/api/sessions/s1/pull-requests/1/automation',
      );
      expect(reset.request.body).toEqual({ resetAttempts: true });
      reset.flush(githubSession());
    });

    it('shows a running run with what triggered it, and stops it', async () => {
      const { all, click } = await render(
        githubSession({
          pullRequests: [
            pull({
              automation: automation({
                autofix: true,
                attempts: 1,
                running: true,
                lastTrigger: 'ci',
                lastRunAt: '2026-01-01T10:00:00.000Z',
              }),
            }),
          ],
        }),
      );
      expect(all('autofix-running')[0]).toContain(
        'Autofix run going on for failed checks',
      );
      await click('autofix-stop');
      http
        .expectOne({ method: 'POST', url: '/api/sessions/s1/autofix/stop' })
        .flush(githubSession());
    });

    it('switches automerge and shows what it waits for', async () => {
      const merging = (
        state: Partial<PullRequestDto['automation']['automerge']>,
      ) =>
        githubSession({
          pullRequests: [
            pull({
              automation: automation({
                autofix: true,
                automerge: { ...pull().automation.automerge, ...state },
              }),
            }),
          ],
        });
      const { fixture, element, all } = await render(
        githubSession({ pullRequests: [pull()] }),
      );
      expect(all('automerge-info')).toEqual([]);
      (
        element.querySelector(
          '[data-testid="automerge-toggle"] button',
        ) as HTMLElement
      ).click();
      const toggle = http.expectOne({
        method: 'PATCH',
        url: '/api/sessions/s1/pull-requests/1/automation',
      });
      expect(toggle.request.body).toEqual({ automerge: true });
      toggle.flush(merging({ enabled: true }));

      const show = (session: SessionDto) => {
        fixture.componentRef.setInput('session', session);
        fixture.detectChanges();
      };
      show(merging({ enabled: true }));
      expect(all('automerge-info')[0]).toContain(
        'rebase, else squash, else merge commit',
      );
      show(merging({ enabled: true, waiting: '2 unresolved review threads' }));
      expect(all('automerge-waiting')).toEqual([
        'Automerge waits: 2 unresolved review threads.',
      ]);
      show(
        merging({
          enabled: true,
          held: {
            since: '2026-01-01T10:00:00.000Z',
            reason: 'Keep the old API?',
          },
        }),
      );
      expect(all('automerge-held')[0]).toContain('Keep the old API?');
      show(merging({ enabled: true, failure: 'GitHub: Merge conflict' }));
      expect(all('automerge-failure')[0]).toContain('GitHub: Merge conflict');
    });

    it('says when the attempt limit was reached', async () => {
      const { all } = await render(
        githubSession({
          pullRequests: [
            pull({
              automation: automation({
                autofix: true,
                attempts: 3,
                gaveUp: true,
              }),
            }),
          ],
        }),
      );
      expect(all('autofix-gave-up')[0]).toContain('Limit reached');
    });

    it('offers to delete clones autoclose kept', async () => {
      const { all } = await render(
        githubSession({
          status: 'finished',
          autoclosedAt: '2026-01-01T11:00:00.000Z',
          pullRequests: [pull({ state: 'merged' })],
        }),
      );
      expect(all('kept-clones')[0]).toContain(
        'Autoclose kept the clone of acme/app',
      );
      expect(all('discard-clone')).toHaveLength(2);
    });

    it('shows what deleting a kept clone would lose before deleting it', async () => {
      const { fixture, all, click } = await render(
        githubSession({
          status: 'finished',
          autoclosedAt: '2026-01-01T11:00:00.000Z',
          pullRequests: [pull({ state: 'merged' })],
        }),
      );
      await click('discard-clone');
      http.expectOne('/api/sessions/s1/repositories/r1/clone-loss').flush({
        repositoryId: 'r1',
        repository: 'acme/app',
        path: '/workspace/sessions/x/acme/app',
        uncommittedFiles: ['notes.txt'],
        uncommittedCount: 1,
        unpushedCommits: [
          { branch: 'claude/x', sha: 'abcdef1234567', subject: 'Local work' },
        ],
        unpushedCount: 1,
        stashes: 2,
        clean: false,
      });
      fixture.detectChanges();
      const dialog = all('discard-clone-dialog')[0];
      expect(dialog).toContain('Delete the clone of acme/app?');
      expect(dialog).toContain('cannot be undone');
      expect(all('loss-files')).toEqual(['notes.txt']);
      expect(all('loss-commits')).toEqual(['abcdef1 Local work (claude/x)']);
      expect(all('loss-stashes')).toEqual(['2 stash entries']);
      await click('discard-clone-confirm');
      const discard = http.expectOne({
        method: 'POST',
        url: '/api/sessions/s1/repositories/r1/discard-clone',
      });
      expect(discard.request.body).toEqual({ confirm: true });
      discard.flush(githubSession());
      fixture.detectChanges();
      expect(all('discard-clone-confirm')).toEqual([]);
      expect(TestBed.inject(Toasts).all()).toMatchObject([
        { title: 'Clone of acme/app deleted', kind: 'info' },
      ]);
    });
  });

  it('shows each clone of a repository with its branch and its own pull requests', async () => {
    const base = githubSession();
    const first = base.directories[0];
    const session = sessionDto({
      directories: [
        first,
        {
          ...first,
          role: 'additional',
          path: `${first.path}-2`,
          branch: 'claude/reply-with-pong-abc123-2',
        },
      ],
      pullRequests: [
        pull(),
        pull({
          id: 2,
          number: 8,
          title: 'Second fix',
          headBranch: 'claude/reply-with-pong-abc123-2',
        }),
      ],
    });
    const { element, fixture, all } = await render(session);
    expect(all('git-clone')).toHaveLength(2);
    expect(all('clone-branch')).toEqual([
      'claude/reply-with-pong-abc123',
      'claude/reply-with-pong-abc123-2',
    ]);
    const clones = [...element.querySelectorAll('[data-testid="git-clone"]')];
    expect(words(clones[0])).toContain('#7 Fix login');
    expect(words(clones[0])).not.toContain('#8');
    expect(words(clones[1])).toContain('#8 Second fix');

    // Push names the clone by its branch.
    (
      clones[1].querySelector('[data-testid="push"]') as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    const request = http.expectOne(
      (req) =>
        req.url === '/api/sessions/s1/repositories/r1/push' &&
        req.params.get('branch') === 'claude/reply-with-pong-abc123-2',
    );
    request.flush(session);
    fixture.detectChanges();
    expect(all('git-message')).toEqual([
      'Pushed claude/reply-with-pong-abc123-2',
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

  it('says when the created pull request is a draft', async () => {
    const { fixture, all, click } = await render(githubSession());
    await click('create-pr');
    await click('pr-submit');
    http
      .expectOne({
        method: 'POST',
        url: '/api/sessions/s1/repositories/r1/pull-requests',
      })
      .flush(pull({ draft: true }));
    fixture.detectChanges();
    expect(all('git-message')).toEqual(['Pull request #7 is a draft']);
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
