import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type {
  RepositoryDiff,
  SessionDiffFile,
  SessionDiffResponse,
} from '@claude-remote-manager/shared-types';
import { words } from '../testing/text';
import { DiffLayoutPreference } from './diff-layout';
import { SessionDiff } from './session-diff';
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
  baseCommit: '0123456789abcdef0123',
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

  const render = async (diff: SessionDiffResponse) => {
    TestBed.configureTestingModule({
      imports: [SessionDiff],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(SessionDiff);
    fixture.componentRef.setInput('sessionId', 's1');
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
      element.querySelector(
        '[data-testid="layout-split"] button',
      ) as HTMLButtonElement
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
