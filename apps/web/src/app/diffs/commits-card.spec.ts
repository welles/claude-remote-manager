import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { CommitsAddedEvent } from '@claude-remote-manager/shared-types';
import { words } from '../testing/text';
import { CommitsCard } from './commits-card';
import { commitSummary, commitsAdded } from './testing/commits';

describe('CommitsCard', () => {
  const render = async (commits: CommitsAddedEvent, showRepository = false) => {
    TestBed.configureTestingModule({
      imports: [CommitsCard],
      providers: [provideRouter([])],
    });
    const fixture = TestBed.createComponent(CommitsCard);
    fixture.componentRef.setInput('commits', commits);
    fixture.componentRef.setInput('sessionId', 's1');
    fixture.componentRef.setInput('showRepository', showRepository);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  };

  it('shows each commit with its message, files and a link to its diff', async () => {
    const element = await render(
      commitsAdded({
        commits: [
          commitSummary({
            body: 'Why it changed.',
            files: [
              {
                path: 'new.ts',
                oldPath: 'old.ts',
                binary: false,
                additions: 1,
                deletions: 2,
              },
              {
                path: 'logo.png',
                oldPath: null,
                binary: true,
                additions: 0,
                deletions: 0,
              },
            ],
            fileCount: 4,
          }),
        ],
      }),
    );
    expect(
      words(element.querySelector('[data-testid="commits-heading"]')),
    ).toBe('1 commit on claude/x');
    const commit = element.querySelector('[data-testid="commit"]');
    expect(words(commit?.querySelector('summary'))).toBe(
      '1a2b3c4 feat: add the thing +3 −1',
    );
    expect(words(commit?.querySelector('[data-testid="commit-body"]'))).toBe(
      'Why it changed.',
    );
    expect(words(commit?.querySelector('[data-testid="commit-files"]'))).toBe(
      'old.ts → new.ts +1 −2 logo.png binary',
    );
    expect(words(commit)).toContain('and 2 more files');
    expect(
      element
        .querySelector('[data-testid="commit-diff-link"]')
        ?.getAttribute('href'),
    ).toBe(
      '/sessions/s1/changes?repository=r1&branch=claude%2Fx&commit=' +
        commitSummary().sha,
    );
  });

  it('says when the branch was rewritten, names the repository and counts the rest', async () => {
    const element = await render(
      commitsAdded({
        rewritten: true,
        commits: [commitSummary(), commitSummary({ sha: 'b'.repeat(40) })],
        commitCount: 53,
      }),
      true,
    );
    expect(
      words(element.querySelector('[data-testid="commits-heading"]')),
    ).toBe('Rewrote 53 commits on claude/x · acme/app');
    expect(words(element)).toContain('and 51 earlier commits');
  });

  it('offers no diff link without a repository', async () => {
    const element = await render(commitsAdded({ repositoryId: null }));
    expect(
      element.querySelector('[data-testid="commit-diff-link"]'),
    ).toBeNull();
  });
});
