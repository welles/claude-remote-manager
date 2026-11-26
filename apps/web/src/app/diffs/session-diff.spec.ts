import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  RepositoryDiff,
  SessionDiffFile,
  SessionDiffResponse,
} from '@claude-remote-manager/shared-types';
import { words } from '../testing/text';
import { DiffLayoutPreference } from './diff-layout';
import { SessionDiff } from './session-diff';
import { commitSummary } from './testing/commits';
import { fileDiff } from './testing/file-diffs';

const file = (overrides: Partial<SessionDiffFile> = {}): SessionDiffFile => ({
  ...fileDiff({ path: 'src/a.ts' }),
  content: 'included',
  ...overrides,
});

const repository = (
  overrides: Partial<RepositoryDiff> = {},
): RepositoryDiff => ({
  repositoryId: 'r1',
  repository: 'acme/app',
  path: '/w/acme/app',
  branch: 'claude/x',
  baseBranch: 'main',
  startCommit: '0123456789abcdef0123',
  comparison: {
    commit: 'abcdef0123456789abcd',
    basis: 'merge_base',
    ref: 'origin/main',
    fallbackReason: null,
  },
  headCommit: 'fedcba',
  state: 'ok',
  message: null,
  files: [file()],
  fileCount: 1,
  additions: 2,
  deletions: 1,
  ...overrides,
});

const response = (repositories: RepositoryDiff[]): SessionDiffResponse => ({
  sessionId: 's1',
  repositories,
  limits: {
    maxFiles: 1000,
    maxFileLines: 3000,
    maxTotalLines: 20000,
    maxSingleFileLines: 20000,
  },
});

describe('SessionDiff', () => {
  let fixture: ComponentFixture<SessionDiff>;
  let http: HttpTestingController;

  const render = async (diff: SessionDiffResponse, linkCommits = false) => {
    TestBed.configureTestingModule({
      imports: [SessionDiff],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(SessionDiff);
    fixture.componentRef.setInput('sessionId', 's1');
    fixture.componentRef.setInput('linkCommits', linkCommits);
    fixture.detectChanges();
    http.expectOne('/api/sessions/s1/diff').flush(diff);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  };

  beforeEach(() => localStorage.clear());
  afterEach(() => http.verify());

  it('lists every repository with its files and their diffs', async () => {
    const element = await render(
      response([
        repository({
          files: [
            file(),
            file({
              path: 'new-name.txt',
              oldPath: 'old-name.txt',
              status: 'renamed',
              additions: 0,
              deletions: 0,
              hunks: [],
            }),
            file({
              path: 'logo.png',
              status: 'added',
              binary: true,
              hunks: [],
            }),
          ],
          fileCount: 5,
        }),
        repository({
          repositoryId: 'r2',
          repository: 'acme/lib',
          state: 'unavailable',
          message: 'The clone is not available (removed).',
          files: [],
          fileCount: 0,
        }),
      ]),
    );
    const sections = element.querySelectorAll(
      '[data-testid="repository-diff"]',
    );
    expect(sections).toHaveLength(2);
    expect(words(sections[0].querySelector('[data-testid="file-list"]'))).toBe(
      'M src/a.ts +2 −1 R old-name.txt → new-name.txt +0 −0 A logo.png binary',
    );
    expect(words(sections[0])).toContain('Showing 3 of 5 changed files.');
    expect(sections[0].querySelectorAll('app-diff-view')).toHaveLength(3);
    expect(words(sections[1])).toContain(
      'The clone is not available (removed).',
    );
    expect(words(sections[0].querySelector('[data-testid="comparison"]'))).toBe(
      'compared with origin/main at its merge base abcdef012345',
    );
    expect(
      sections[0].querySelector('[data-testid="comparison-fallback"]'),
    ).toBeNull();
  });

  it('lists the commits of each repository, linked to their diffs', async () => {
    const merge = commitSummary({
      sha: 'c'.repeat(40),
      parents: ['a'.repeat(40), 'b'.repeat(40)],
      subject: 'Merge main',
      files: [],
    });
    const element = await render(
      response([
        repository({
          commits: [merge, commitSummary({ subject: '' })],
          commitCount: 3,
        }),
        repository({ repositoryId: 'r2', commits: [], commitCount: 0 }),
      ]),
      true,
    );
    const lists = element.querySelectorAll('[data-testid="commit-list"]');
    expect(lists).toHaveLength(1);
    const rows = lists[0].querySelectorAll('[data-testid="listed-commit"]');
    expect(words(rows[0])).toMatch(/^ccccccc Merge main merge · /);
    expect(words(rows[1])).toMatch(/^1a2b3c4 \(no message\) \+3 −1 · /);
    expect(words(lists[0])).toContain('3 commits');
    expect(words(lists[0])).toContain('Showing the newest 2.');
    expect(rows[1].querySelector('a')?.getAttribute('href')).toBe(
      '/?repository=r1&branch=claude%2Fx&commit=' + commitSummary().sha,
    );
  });

  it('says when it compares with the start commit, and why', async () => {
    const element = await render(
      response([
        repository({
          comparison: {
            commit: '0123456789abcdef0123',
            basis: 'start_commit',
            ref: null,
            fallbackReason: 'The clone does not know origin/main.',
          },
        }),
      ]),
    );
    expect(words(element.querySelector('[data-testid="comparison"]'))).toBe(
      'compared with the commit it started from 0123456789ab',
    );
    expect(
      words(element.querySelector('[data-testid="comparison-fallback"]')),
    ).toBe(
      "The clone does not know origin/main. Changes brought in from main may show as the session's.",
    );
  });

  it('switches between unified and side by side and remembers it', async () => {
    const element = await render(response([repository()]));
    const preference = TestBed.inject(DiffLayoutPreference);
    preference.set('unified');
    await fixture.whenStable();
    expect(
      element.querySelector('[data-testid="diff-unified"]'),
    ).not.toBeNull();
    (
      element.querySelector('[data-testid="layout-split"]') as HTMLButtonElement
    ).click();
    await fixture.whenStable();
    expect(element.querySelector('[data-testid="diff-split"]')).not.toBeNull();
    expect(localStorage.getItem('crm.diffLayout')).toBe('split');
  });

  it('loads files left out for their size on request', async () => {
    const element = await render(
      response([
        repository({
          files: [file({ path: 'big.txt', content: 'too_large', hunks: [] })],
        }),
      ]),
    );
    expect(words(element)).toContain('too many changed lines');
    (
      element.querySelector('[data-testid="load-file"]') as HTMLButtonElement
    ).click();
    http
      .expectOne(
        (request) =>
          request.url === '/api/sessions/s1/diff/file' &&
          request.params.get('repositoryId') === 'r1' &&
          request.params.get('path') === 'big.txt' &&
          !request.params.has('oldPath'),
      )
      .flush(file({ path: 'big.txt', truncated: true }));
    await fixture.whenStable();
    expect(element.querySelector('[data-testid="file-left-out"]')).toBeNull();
    expect(
      element.querySelector('[data-testid="diff-truncated"]'),
    ).not.toBeNull();
  });
});
