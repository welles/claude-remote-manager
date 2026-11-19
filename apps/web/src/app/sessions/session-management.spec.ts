import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  CleanupDirectory,
  CleanupPreview,
  DeletionPreview,
  DirectoryLoss,
} from '@claude-remote-manager/shared-types';
import { words } from '../testing/text';
import { Toasts } from '../ui/toasts';
import { CleanupDialog, type CleanupMode, lossOf } from './cleanup-dialog';
import { DeleteSessionDialog } from './delete-session-dialog';
import { SessionTitle } from './session-title';
import { snippetParts } from './session-search';
import { sessionDto } from './testing/session-dto';

const clean: DirectoryLoss = {
  files: [],
  fileCount: 0,
  unpushedCommits: [],
  unpushedCount: 0,
  stashes: 0,
  bytes: 2_500_000,
  clean: true,
};

const directory = (
  overrides: Partial<CleanupDirectory> = {},
): CleanupDirectory => ({
  position: 0,
  kind: 'clone',
  name: 'acme/app',
  repositoryId: 'r1',
  path: '/workspace/sessions/x/acme/app',
  branch: 'claude/x',
  baseBranch: 'main',
  actions: ['push', 'discard', 'keep'],
  hasCommits: true,
  loss: {
    ...clean,
    files: ['draft.txt'],
    fileCount: 1,
    unpushedCommits: [
      { branch: 'claude/x', sha: 'abcdef123', subject: 'Work' },
    ],
    unpushedCount: 1,
    clean: false,
  },
  lossAfterIntegration: {
    ...clean,
    files: ['draft.txt'],
    fileCount: 1,
    clean: false,
  },
  error: null,
  ...overrides,
});

@Component({
  imports: [CleanupDialog, DeleteSessionDialog],
  template: `
    <app-cleanup-dialog sessionId="s1" />
    <app-delete-session-dialog sessionId="s1" />
  `,
})
class Host {
  readonly cleanup = viewChild.required(CleanupDialog);
  readonly remove = viewChild.required(DeleteSessionDialog);
}

describe('session management', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Host, SessionTitle],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  const render = async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const all = (testId: string) =>
      [...element.querySelectorAll(`[data-testid="${testId}"]`)].map((node) =>
        words(node),
      );
    const find = (testId: string) =>
      element.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
    const click = async (selector: string) => {
      (element.querySelector(selector) as HTMLElement).click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    return { fixture, element, all, find, click };
  };

  const openCleanup = async (mode: CleanupMode, preview: CleanupPreview) => {
    const view = await render();
    view.fixture.componentInstance.cleanup().show(mode);
    http.expectOne('/api/sessions/s1/cleanup').flush(preview);
    view.fixture.detectChanges();
    await view.fixture.whenStable();
    view.fixture.detectChanges();
    return view;
  };

  it('keeps everything by default and archives without cleanup', async () => {
    const view = await openCleanup('archive', {
      sessionId: 's1',
      // A session that waits cannot be cleaned up, but archived.
      blocked: 'End the session before cleaning up its clones',
      archiveBlocked: null,
      directories: [directory()],
      previews: 0,
    });
    expect(view.all('cleanup-dialog')[0]).toContain('Archive this session?');
    expect(view.all('no-resume-note')).toEqual([]);
    await view.click('[data-testid="cleanup-confirm"]');
    const request = http.expectOne('/api/sessions/s1/archive');
    expect(request.request.body).toEqual({ cleanup: [] });
    request.flush({ session: sessionDto(), outcomes: [] });
    view.fixture.detectChanges();
    // The result needs nothing from the user: a toast, the dialog closes.
    expect(TestBed.inject(Toasts).all()).toMatchObject([
      {
        title: 'Session archived',
        lines: ['Nothing was cleaned up.'],
        kind: 'info',
      },
    ]);
    expect(view.all('cleanup-confirm')).toEqual([]);
  });

  it('shows what a push leaves behind and needs the loss accepted', async () => {
    const view = await openCleanup('cleanup', {
      sessionId: 's1',
      blocked: null,
      archiveBlocked: null,
      directories: [directory()],
      previews: 0,
    });
    await view.click('[data-testid="choice-push"] input');
    expect(view.all('cleanup-directory')[0]).toContain('Still lost afterwards');
    expect(view.all('loss-files')).toEqual(['draft.txt']);
    expect(view.all('no-resume-note')).toEqual([
      'Afterwards the session can still be read, but not continued.',
    ]);
    const confirm = view.find('cleanup-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await view.click('[data-testid="accept-loss"] input');
    expect(confirm.disabled).toBe(false);
    await view.click('[data-testid="cleanup-confirm"]');
    const request = http.expectOne('/api/sessions/s1/cleanup');
    expect(request.request.body).toEqual({
      directories: [{ position: 0, action: 'push', acceptLoss: true }],
    });
    request.flush({
      session: sessionDto(),
      outcomes: [
        {
          position: 0,
          name: 'acme/app',
          action: 'push',
          result: 'removed',
          message:
            'pushed claude/x (abcdef1), removed (lost 1 uncommitted file)',
        },
      ],
    });
    view.fixture.detectChanges();
    expect(TestBed.inject(Toasts).all()).toMatchObject([
      {
        title: 'Cleaned up',
        lines: [
          'acme/app: pushed claude/x (abcdef1), removed (lost 1 uncommitted file)',
        ],
        kind: 'info',
      },
    ]);
  });

  it('reports a partial failure as a toast that stays, and errors in the dialog', async () => {
    const preview: CleanupPreview = {
      sessionId: 's1',
      blocked: null,
      archiveBlocked: null,
      directories: [directory({ loss: clean, lossAfterIntegration: null })],
      previews: 0,
    };
    const view = await openCleanup('cleanup', preview);
    await view.click('[data-testid="choice-discard"] input');
    await view.click('[data-testid="cleanup-confirm"]');
    // Refused: the dialog stays with the reason, no toast.
    http
      .expectOne('/api/sessions/s1/cleanup')
      .flush(
        { message: 'The session is running' },
        { status: 409, statusText: 'Conflict' },
      );
    view.fixture.detectChanges();
    expect(view.all('cleanup-dialog')[0]).toContain('The session is running');
    expect(TestBed.inject(Toasts).all()).toEqual([]);

    await view.click('[data-testid="cleanup-confirm"]');
    http.expectOne('/api/sessions/s1/cleanup').flush({
      session: sessionDto(),
      outcomes: [
        {
          position: 0,
          name: 'acme/app',
          action: 'discard',
          result: 'failed',
          message: 'permission denied',
        },
      ],
    });
    view.fixture.detectChanges();
    expect(view.all('cleanup-confirm')).toEqual([]);
    expect(TestBed.inject(Toasts).all()).toMatchObject([
      {
        title: 'The cleanup failed in part',
        lines: ['Failed: acme/app: permission denied'],
        kind: 'error',
      },
    ]);
  });

  it('reports the answer as a toast when the dialog was closed meanwhile', async () => {
    const view = await openCleanup('archive', {
      sessionId: 's1',
      blocked: null,
      archiveBlocked: null,
      directories: [directory({ loss: clean, lossAfterIntegration: null })],
      previews: 0,
    });
    await view.click('[data-testid="cleanup-confirm"]');
    await view.click(
      '[data-testid="cleanup-dialog"] button[aria-label="Close"]',
    );
    http
      .expectOne('/api/sessions/s1/archive')
      .flush({ message: 'Not now' }, { status: 409, statusText: 'Conflict' });
    expect(TestBed.inject(Toasts).all()).toMatchObject([
      { title: 'The session was not archived', kind: 'error' },
    ]);
  });

  it('says why a running session cannot be cleaned up', async () => {
    const view = await openCleanup('cleanup', {
      sessionId: 's1',
      blocked: 'Claude is working on a turn; stop it first',
      archiveBlocked: 'Claude is working on a turn; stop it first',
      directories: [directory({ loss: clean, lossAfterIntegration: null })],
      previews: 0,
    });
    expect(view.all('cleanup-dialog')[0]).toContain('stop it first');
    expect((view.find('cleanup-confirm') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('knows what each choice loses', () => {
    const entry = directory();
    expect(lossOf('keep', entry)).toBeNull();
    expect(lossOf('discard', entry)?.unpushedCount).toBe(1);
    expect(lossOf('push', entry)?.unpushedCount).toBe(0);
    expect(lossOf('push', { ...entry, hasCommits: false })).toBe(entry.loss);
  });

  it('lists what deleting removes and keeps, and needs dirty clones accepted', async () => {
    const view = await render();
    view.fixture.componentInstance.remove().show();
    const preview: DeletionPreview = {
      sessionId: 's1',
      blocked: null,
      directories: [directory()],
      transcript: true,
      attachments: 2,
      shownFiles: 1,
      pullRequests: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        costUsd: 1.25,
      },
    };
    http.expectOne('/api/sessions/s1/deletion').flush(preview);
    view.fixture.detectChanges();
    const text = view.all('delete-dialog')[0];
    expect(text).toContain("Claude Code's transcript");
    expect(text).toContain('2 attached image(s)');
    expect(text).toContain('the clone of acme/app');
    expect(text).toContain('$1.25 theoretical API cost');
    expect(text).toContain('1 pull request(s) on GitHub');
    expect(view.all('delete-loss')[0]).toContain('draft.txt');
    const confirm = view.find('delete-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await view.click('[data-testid="delete-accept-loss"] input');
    expect(confirm.disabled).toBe(false);
    await view.click('[data-testid="delete-confirm"]');
    const request = http.expectOne('/api/sessions/s1/delete');
    expect(request.request.body).toEqual({ confirm: true, acceptLoss: true });
    request.flush(null);
  });

  it('renames only the title and says so', async () => {
    const fixture = TestBed.createComponent(SessionTitle);
    fixture.componentRef.setInput('session', sessionDto());
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    (element.querySelector('[data-testid="rename"]') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(words(element)).toContain(
      'the branch claude/reply-with-pong-abc123 and the directory names stay as they are',
    );
    const input = element.querySelector(
      '[data-testid="rename-input"]',
    ) as HTMLInputElement;
    // A dialog that is one text field starts in the field.
    expect(document.activeElement).toBe(input);
    input.value = '  New name ';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (
      element.querySelector('[data-testid="rename-save"]') as HTMLElement
    ).click();
    const request = http.expectOne('/api/sessions/s1');
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ title: 'New name' });
    request.flush(sessionDto({ title: 'New name' }));
  });

  it('splits search snippets into plain and highlighted parts', () => {
    expect(
      snippetParts({
        kind: 'user',
        snippet: 'fix the login bug',
        highlights: [
          [4, 7],
          [8, 13],
        ],
        anchor: null,
      }),
    ).toEqual([
      { text: 'fix ', hit: false },
      { text: 'the', hit: true },
      { text: ' ', hit: false },
      { text: 'login', hit: true },
      { text: ' bug', hit: false },
    ]);
  });
});
