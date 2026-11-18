import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkSeparateUsers,
  effectiveCapabilities,
  findExecutable,
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

  it('keeps the environment of the user for sessions in single-user mode', () => {
    const launcher = new ProcessLauncher(
      {
        mode: 'single-user',
        sessionPath: '/run/wrappers/bin:/home/u/.nix-profile/bin',
      },
      { GIT_CONFIG_GLOBAL: '/var/lib/crm/git/gitconfig' },
    );
    const base = {
      PATH: '/nix/store/x-git/bin',
      HOME: '/home/u',
      SSH_AUTH_SOCK: '/run/user/1000/ssh-agent',
      GH_CONFIG_DIR: '/home/u/.config/gh',
      CRM_SECRET_X: 'secret',
    };
    expect(launcher.environment('session', { X: '1' }, { base })).toEqual({
      PATH: '/run/wrappers/bin:/home/u/.nix-profile/bin',
      HOME: '/home/u',
      SSH_AUTH_SOCK: '/run/user/1000/ssh-agent',
      GH_CONFIG_DIR: '/home/u/.config/gh',
      X: '1',
    });
    // Only the API's own processes (git on mirrors) get its git configuration.
    expect(launcher.environment('api', {}, { base })).toEqual({
      PATH: '/nix/store/x-git/bin',
      HOME: '/home/u',
      SSH_AUTH_SOCK: '/run/user/1000/ssh-agent',
      GH_CONFIG_DIR: '/home/u/.config/gh',
      GIT_CONFIG_GLOBAL: '/var/lib/crm/git/gitconfig',
    });
  });

  it("keeps the API's own configuration from sessions in single-user mode", () => {
    const launcher = new ProcessLauncher({ mode: 'single-user' });
    const base = {
      HOME: '/home/u',
      NODE_ENV: 'production',
      PORT: '8080',
      DB_DIR: '/var/lib/crm/db',
      WORKSPACE_DIR: '/var/lib/crm/workspace',
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY_FILE: '/run/credentials/x/github-app-key',
      CREDENTIALS_DIRECTORY: '/run/credentials/x',
      WEB_ROOT: '/nix/store/x-web',
      CLAUDE_CODE_OAUTH_TOKEN: 'token',
      // The user's own variables stay, also file pointers.
      SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
      SOPS_AGE_KEY_FILE: '/home/u/.config/sops/age/keys.txt',
    };
    expect(
      launcher.environment('session', {}, {
        base,
        keep: ['CLAUDE_CODE_OAUTH_TOKEN'],
      }),
    ).toEqual({
      HOME: '/home/u',
      CLAUDE_CODE_OAUTH_TOKEN: 'token',
      SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
      SOPS_AGE_KEY_FILE: '/home/u/.config/sops/age/keys.txt',
    });
  });

  it('starts session processes as the session user without capabilities', () => {
    const launcher = new ProcessLauncher(separated);
    expect(launcher.command('session', 'git', ['status'])).toEqual({
      command: launcher.setpriv,
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
      command: launcher.setpriv,
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

  it('resolves setpriv in its own PATH, not in the child environment', () => {
    const launcher = new ProcessLauncher(separated);
    const found = findExecutable('setpriv');
    expect(launcher.setpriv).toBe(found ?? 'setpriv');
  });

  it('gives session processes the session PATH when configured', () => {
    const launcher = new ProcessLauncher({
      ...separated,
      sessionPath: '/home/claude/.nix-profile/bin:/bin',
    } as ProcessIsolation);
    const base = { PATH: '/bin', LOCALE_ARCHIVE: '/locale' };
    expect(launcher.environment('session', {}, { base })).toMatchObject({
      PATH: '/home/claude/.nix-profile/bin:/bin',
      LOCALE_ARCHIVE: '/locale',
    });
    // The API's own processes keep the API's PATH.
    expect(launcher.environment('api', {}, { base })).toMatchObject({
      PATH: '/bin',
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

  const setpriv = '/usr/bin/setpriv';

  it('accepts the API user with the capabilities', () => {
    expect(() =>
      checkSeparateUsers(separated, 1000, all, setpriv),
    ).not.toThrow();
    expect(() =>
      checkSeparateUsers({ mode: 'single-user' }, 0, 0n),
    ).not.toThrow();
  });

  it('refuses root, the session user and missing capabilities', () => {
    expect(() => checkSeparateUsers(separated, 0, all, setpriv)).toThrow(
      'not run as root',
    );
    expect(() => checkSeparateUsers(separated, 1001, all, setpriv)).toThrow(
      'runs as the session user',
    );
    expect(() =>
      checkSeparateUsers(separated, 1000, all & ~(1n << 7n), setpriv),
    ).toThrow('lacks CAP_SETUID');
    expect(() => checkSeparateUsers(separated, 1000, all, null)).toThrow(
      'setpriv (util-linux) is not on',
    );
  });

  it('finds executables only in absolute PATH directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crm-path-'));
    try {
      mkdirSync(join(dir, 'bin'));
      mkdirSync(join(dir, 'dir', 'tool'), { recursive: true });
      writeFileSync(join(dir, 'bin', 'tool'), '#!/bin/sh\n');
      chmodSync(join(dir, 'bin', 'tool'), 0o755);
      writeFileSync(join(dir, 'bin', 'plain'), '');
      expect(
        findExecutable(
          'tool',
          `relative:${join(dir, 'dir')}:${join(dir, 'bin')}`,
        ),
      ).toBe(join(dir, 'bin', 'tool'));
      expect(findExecutable('plain', join(dir, 'bin'))).toBeNull();
      expect(findExecutable('tool', '')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
