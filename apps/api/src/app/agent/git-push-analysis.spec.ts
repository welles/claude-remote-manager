import { analyzeGitPushes } from './git-push-analysis';

const SESSION = ['claude/fix-abc123'];
const one = (command: string, checkedOut = SESSION) => {
  const [analysis] = analyzeGitPushes(command, SESSION, checkedOut);
  return analysis;
};

describe('analyzeGitPushes', () => {
  it.each([
    'git push',
    'git push -u origin HEAD',
    'git push origin claude/fix-abc123',
    'git push origin HEAD:claude/fix-abc123',
    'cd /w/app && git push origin refs/heads/claude/fix-abc123',
  ])('treats %s as a push of the session branch only', (command) => {
    expect(one(command)).toMatchObject({
      sessionBranchOnly: true,
      warnings: [],
    });
  });

  it('warns about other branches, also the default branch', () => {
    const analysis = one('git push origin HEAD:main');
    expect(analysis.sessionBranchOnly).toBe(false);
    expect(analysis.targets).toEqual([
      { destination: 'main', branch: 'main', forced: false, deletes: false },
    ]);
    expect(analysis.warnings).toEqual([
      'Pushes to main, not only the session branch',
    ]);
  });

  it('warns about force, deletes and pushing everything', () => {
    expect(one('git push --force origin HEAD').warnings).toEqual([
      'Force push: may overwrite commits on the remote',
    ]);
    expect(one('git push --force-with-lease').force).toBe(true);
    expect(one('git push -uf origin HEAD').force).toBe(true);
    expect(one('git push origin +claude/fix-abc123').force).toBe(true);
    expect(one('git push origin :old-branch')).toMatchObject({
      deletes: true,
      sessionBranchOnly: false,
    });
    expect(one('git push --delete origin claude/fix-abc123').deletes).toBe(
      true,
    );
    expect(one('git push --all origin').everything).toBe(true);
    expect(one('git push --tags').everything).toBe(true);
    expect(one('git push --mirror').everything).toBe(true);
  });

  it('warns about other remotes', () => {
    expect(one('git push https://evil.example/x.git HEAD').warnings).toEqual([
      'Pushes to the remote "https://evil.example/x.git", not origin',
    ]);
  });

  it('warns when HEAD is not the session branch', () => {
    expect(one('git push', ['main']).warnings).toEqual([
      'Pushes to the checked-out branch (main), not only the session branch',
    ]);
  });

  it('finds every push in a command, and only pushes', () => {
    expect(
      analyzeGitPushes(
        'git status && git push && git push origin HEAD:main',
        SESSION,
      ),
    ).toHaveLength(2);
    expect(analyzeGitPushes('echo git push; git stash push', SESSION)).toEqual(
      [],
    );
    expect(
      analyzeGitPushes("git -C '/w/my app' push origin main", SESSION)[0]
        .targets[0].destination,
    ).toBe('main');
  });
});
