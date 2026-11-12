import {
  GitError,
  gitEnvironment,
  isLockContention,
  retryOnLockContention,
  runGit,
} from './git-runner';

describe('git runner', () => {
  it('builds a non-interactive environment without repository overrides', () => {
    const env = gitEnvironment({
      PATH: '/bin',
      GIT_DIR: '/elsewhere',
      GIT_WORK_TREE: '/elsewhere',
      GIT_INDEX_FILE: '/elsewhere/index',
    });
    expect(env).toEqual({
      PATH: '/bin',
      LC_ALL: 'C',
      LANGUAGE: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: 'https:ssh:file',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    });
    expect(
      gitEnvironment({ GIT_SSH_COMMAND: 'ssh -i key' })['GIT_SSH_COMMAND'],
    ).toBe('ssh -i key');
  });

  it('reports failures with git’s message', async () => {
    const error = await runGit(['--git-dir=/nonexistent', 'status']).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).message).toMatch(/^git status failed: /);
    expect((error as GitError).exitCode).toBe(128);
  });

  it('refuses the ext transport', async () => {
    await expect(
      runGit(['ls-remote', '--', 'ext::sh -c true'], { timeoutMs: 10_000 }),
    ).rejects.toThrow(/transport 'ext' not allowed/);
  });

  it('retries only on lock contention', async () => {
    const lock = new GitError(
      'git fetch failed',
      [],
      1,
      "error: cannot lock ref 'refs/remotes/origin/main': Unable to create '/r/refs/remotes/origin/main.lock': File exists.",
    );
    expect(isLockContention(lock)).toBe(true);
    expect(isLockContention(new GitError('x', [], 1, 'fatal: bad'))).toBe(
      false,
    );

    let calls = 0;
    await expect(
      retryOnLockContention(async () => {
        if (++calls < 3) {
          throw lock;
        }
        return 'ok';
      }, [1, 1, 1]),
    ).resolves.toBe('ok');
    expect(calls).toBe(3);

    calls = 0;
    await expect(
      retryOnLockContention(async () => {
        calls++;
        throw new Error('other');
      }, [1, 1]),
    ).rejects.toThrow('other');
    expect(calls).toBe(1);
  });
});
