import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  CommitDiffResponse,
  SessionDiffFile,
} from '@claude-remote-manager/shared-types';
import { words } from '../testing/text';
import { CommitDiff } from './commit-diff';
import { commitSummary } from './testing/commits';
import { fileDiff } from './testing/file-diffs';

const file = (overrides: Partial<SessionDiffFile> = {}): SessionDiffFile => ({
  ...fileDiff({ path: 'src/a.ts' }),
  content: 'included',
  ...overrides,
});

const response = (
  overrides: Partial<CommitDiffResponse> = {},
): CommitDiffResponse => ({
  repositoryId: 'r1',
  repository: 'acme/app',
  branch: 'claude/x',
  commit: commitSummary({ body: 'The reason.' }),
  parent: '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f',
  files: [file(), file({ path: 'big.txt', content: 'omitted', hunks: [] })],
  fileCount: 2,
  limits: {
    maxFiles: 1000,
    maxFileLines: 3000,
    maxTotalLines: 20000,
    maxSingleFileLines: 20000,
  },
  ...overrides,
});

describe('CommitDiff', () => {
  let fixture: ComponentFixture<CommitDiff>;
  let http: HttpTestingController;
  const sha = commitSummary().sha;

  const render = async () => {
    TestBed.configureTestingModule({
      imports: [CommitDiff],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CommitDiff);
    fixture.componentRef.setInput('sessionId', 's1');
    fixture.componentRef.setInput('repositoryId', 'r1');
    fixture.componentRef.setInput('branch', 'claude/x');
    fixture.componentRef.setInput('sha', sha);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  afterEach(() => http.verify());

  it('shows the commit with its message and its files, and loads left-out files', async () => {
    const element = await render();
    http
      .expectOne(
        (request) =>
          request.url === '/api/sessions/s1/diff/commit' &&
          request.params.get('repositoryId') === 'r1' &&
          request.params.get('branch') === 'claude/x' &&
          request.params.get('sha') === sha,
      )
      .flush(response());
    await fixture.whenStable();
    const section = element.querySelector('[data-testid="commit-diff"]');
    expect(words(section?.querySelector('h2'))).toBe('feat: add the thing');
    expect(words(section?.querySelector('[data-testid="commit-body"]'))).toBe(
      'The reason.',
    );
    expect(
      words(section?.querySelector('[data-testid="commit-summary"]')),
    ).toBe('Compared with its parent 0f0f0f0f0f0f · 2 files changed, +3 −1');
    expect(element.querySelectorAll('[data-testid="file-diff"]')).toHaveLength(
      2,
    );

    (
      element.querySelector('[data-testid="load-file"]') as HTMLButtonElement
    ).click();
    http
      .expectOne(
        (request) =>
          request.url === '/api/sessions/s1/diff/commit/file' &&
          request.params.get('sha') === sha &&
          request.params.get('path') === 'big.txt',
      )
      .flush(file({ path: 'big.txt' }));
    await fixture.whenStable();
    expect(element.querySelector('[data-testid="file-left-out"]')).toBeNull();
  });

  it('says when the commit cannot be loaded', async () => {
    const element = await render();
    http
      .expectOne((request) => request.url === '/api/sessions/s1/diff/commit')
      .flush(
        { message: `The clone has no commit ${sha}` },
        { status: 404, statusText: 'Not Found' },
      );
    await fixture.whenStable();
    expect(words(element.querySelector('[data-testid="commit-error"]'))).toBe(
      `The clone has no commit ${sha}`,
    );
  });
});
