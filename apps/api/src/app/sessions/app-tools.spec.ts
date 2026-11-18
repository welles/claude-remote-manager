import { isGitPushCommand } from './app-tools';

describe('isGitPushCommand', () => {
  it.each([
    'git push',
    'git push -u origin HEAD',
    'cd /w/app && git push origin claude/x',
    'git -C /w/app push',
    'git -c http.extraHeader=x push',
    'npm test; git push',
    '/usr/bin/git push --force-with-lease',
    'echo $(git push)',
  ])('recognizes %s', (command) => {
    expect(isGitPushCommand(command)).toBe(true);
  });

  it.each([
    'git status',
    'git log --grep push',
    'echo git push',
    'git stash push',
    'npm run push',
    'gitpush',
    'git commit -m "push later"',
  ])('does not treat %s as a push', (command) => {
    expect(isGitPushCommand(command)).toBe(false);
  });
});
