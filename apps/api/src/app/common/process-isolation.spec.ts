import {
  checkSeparateUsers,
  effectiveCapabilities,
  lookupUser,
  ProcessLauncher,
  SINGLE_USER,
  type ProcessIsolation,
} from './process-isolation';

const separated: ProcessIsolation = {
  mode: 'separate-users',
  sessionUser: { name: 'claude', uid: 1001, gid: 1001, home: '/home/claude' },
};

describe('ProcessLauncher', () => {
  it('runs everything directly in single-user mode', () => {
    expect(SINGLE_USER.command('session', 'git', ['status'])).toEqual({
      command: 'git',
      args: ['status'],
    });
    expect(
      SINGLE_USER.environment(
        'session',
        { X: '1' },
        {
          base: { PATH: '/bin', CRM_SECRET_A: 's', OTHER: 'o' },
        },
      ),
    ).toEqual({ PATH: '/bin', OTHER: 'o', X: '1' });
  });

  it('starts session processes as the session user without capabilities', () => {
    const launcher = new ProcessLauncher(separated);
    expect(launcher.command('session', 'git', ['status'])).toEqual({
      command: 'setpriv',
      args: [
        '--reuid=1001',
        '--regid=1001',
        '--init-groups',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--no-new-privs',
        '--',
        'git',
        'status',
      ],
    });
    // The API's own processes only lose the capabilities.
    expect(launcher.command('api', 'git', ['fetch'])).toEqual({
      command: 'setpriv',
      args: [
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--no-new-privs',
        '--',
        'git',
        'fetch',
      ],
    });
  });

  it('gives session processes only allowlisted variables', () => {
    const launcher = new ProcessLauncher(separated);
    const base = {
      PATH: '/bin',
      HOME: '/home/crm',
      CLAUDE_CONFIG_DIR: '/data/claude',
      GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/key',
      GIT_CONFIG_GLOBAL: '/data/git/gitconfig',
      DB_DIR: '/data/db',
      CRM_SECRET_X: 'secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'login',
    };
    expect(
      launcher.environment('session', { CRM_SESSION_TOKEN: 't' }, { base }),
    ).toEqual({
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: '/data/claude',
      HOME: '/home/claude',
      USER: 'claude',
      LOGNAME: 'claude',
      CRM_SESSION_TOKEN: 't',
    });
    expect(
      launcher.environment(
        'session',
        {},
        { base, keep: ['CLAUDE_CODE_OAUTH_TOKEN'] },
      ),
    ).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'login' });
    // The API's own processes keep its environment, without secrets.
    expect(launcher.environment('api', {}, { base })).not.toHaveProperty(
      'CRM_SECRET_X',
    );
    expect(launcher.environment('api', {}, { base })).toHaveProperty('DB_DIR');
  });
});

describe('separate-users checks', () => {
  const all = (1n << 0n) | (1n << 1n) | (1n << 5n) | (1n << 6n) | (1n << 7n);

  it('accepts the API user with the capabilities', () => {
    expect(() => checkSeparateUsers(separated, 1000, all)).not.toThrow();
    expect(() =>
      checkSeparateUsers({ mode: 'single-user' }, 0, 0n),
    ).not.toThrow();
  });

  it('refuses root, the session user and missing capabilities', () => {
    expect(() => checkSeparateUsers(separated, 0, all)).toThrow(
      'not run as root',
    );
    expect(() => checkSeparateUsers(separated, 1001, all)).toThrow(
      'runs as the session user',
    );
    expect(() =>
      checkSeparateUsers(separated, 1000, all & ~(1n << 7n)),
    ).toThrow('lacks CAP_SETUID');
  });

  it('reads capabilities and users', () => {
    expect(effectiveCapabilities('Name:\tx\nCapEff:\t00000000000000e3\n')).toBe(
      0xe3n,
    );
    expect(
      lookupUser(
        'claude',
        'crm:x:1000:1000::/home/crm:/bin/sh\nclaude:x:1001:1002::/home/claude:/bin/bash\n',
      ),
    ).toEqual({ name: 'claude', uid: 1001, gid: 1002, home: '/home/claude' });
  });
});
