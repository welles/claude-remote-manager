import { parseAutofixGitCommand, shellWords } from './autofix-git';

describe('autofix git commands', () => {
  it('splits words like the shell for the plain forms only', () => {
    expect(shellWords(`git commit -m "Fix it" && git push`)).toEqual([
      ['git', 'commit', '-m', 'Fix it'],
      ['git', 'push'],
    ]);
    expect(shellWords('git commit -m \'a "b" $c\'')).toEqual([
      ['git', 'commit', '-m', 'a "b" $c'],
    ]);
    expect(shellWords('git commit -m "line 1\n\nline 2"')).toEqual([
      ['git', 'commit', '-m', 'line 1\n\nline 2'],
    ]);
    for (const command of [
      'git push; rm -rf x',
      'git push | cat',
      'git push > out',
      'git push &',
      'git push\ngit status',
      'git commit -m "$(date)"',
      'git commit -m "`id`"',
      'git commit -m "a\\"b"',
      'git add *.ts',
      'git add ~/x',
      '&& git push',
      'git push &&',
      'git commit -m "open',
    ]) {
      expect([command, shellWords(command)]).toEqual([command, null]);
    }
  });

  it('accepts add, commit and a last push, in one directory', () => {
    expect(
      parseAutofixGitCommand(
        'cd /w/app && git add -A && git commit -q -m "Fix" && git push origin HEAD',
      ),
    ).toEqual({
      location: ['/w/app'],
      steps: [
        { kind: 'add', args: ['-A'] },
        { kind: 'commit', args: ['-q', '-m', 'Fix'], amend: false },
        { kind: 'push' },
      ],
    });
    expect(parseAutofixGitCommand('git -C sub add -- a.txt b/c.txt')).toEqual({
      location: ['sub'],
      steps: [{ kind: 'add', args: ['--', 'a.txt', 'b/c.txt'] }],
    });
    expect(
      parseAutofixGitCommand('git commit -am "All" --no-verify')?.steps,
    ).toEqual([
      { kind: 'commit', args: ['-am', 'All', '--no-verify'], amend: false },
    ]);
    expect(
      parseAutofixGitCommand('git commit --amend --no-edit')?.steps,
    ).toEqual([
      { kind: 'commit', args: ['--amend', '--no-edit'], amend: true },
    ]);
  });

  it.each([
    'git status',
    'git add . && npm test',
    'git push && git add .',
    'git commit',
    'git commit --amend',
    'git commit -F msg',
    'git commit -m x --author=someone',
    'git commit -m x -S',
    'git commit -m x path/file',
    'git commit -C HEAD',
    'git add -f x',
    'git add -p',
    'git add ../x',
    'git add /etc/passwd',
    "git add ':(top)x'",
    'git -c core.hooksPath=/tmp/h commit -m x',
    'git --git-dir=/x commit -m x',
    'git -C a add . && git -C b commit -m x',
    'cd a && git add . && cd b && git commit -m x',
    'cd a b && git add .',
    'sudo git add .',
    'cd /w && ls',
  ])('refuses %s', (command) => {
    expect(parseAutofixGitCommand(command)).toBeNull();
  });
});
