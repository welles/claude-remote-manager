import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEV_ORIGINS, loadAppConfig } from './app-config';

describe('loadAppConfig', () => {
  it('uses development defaults outside the image', () => {
    const devData = join(homedir(), '.local/share/claude-remote-manager');
    expect(loadAppConfig({})).toEqual({
      dbDir: resolve('data/db'),
      reposDir: join(devData, 'repos'),
      worktreesDir: join(devData, 'worktrees'),
      projectsDir: join(devData, 'projects'),
      setupScriptTimeoutMs: 15 * 60_000,
      sessionIdleTimeoutMs: 60 * 60_000,
      claudeExecutable: null,
      allowedOrigins: DEV_ORIGINS,
      allowedHosts: [],
    });
  });

  it('reads the image environment', () => {
    expect(
      loadAppConfig({
        DB_DIR: '/data/db',
        REPOS_DIR: '/data/repos',
        WORKTREES_DIR: '/data/worktrees/',
        PROJECTS_DIR: '/data/projects',
        SETUP_SCRIPT_TIMEOUT_MINUTES: '5',
        SESSION_IDLE_TIMEOUT_MINUTES: '0',
        CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude',
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: 'https://crm.example.com/, https://other.example:8443',
        ALLOWED_HOSTS: 'crm.example.com,crm.internal',
      }),
    ).toEqual({
      dbDir: '/data/db',
      reposDir: '/data/repos',
      worktreesDir: '/data/worktrees',
      projectsDir: '/data/projects',
      setupScriptTimeoutMs: 5 * 60_000,
      sessionIdleTimeoutMs: 0,
      claudeExecutable: '/usr/local/bin/claude',
      allowedOrigins: ['https://crm.example.com', 'https://other.example:8443'],
      allowedHosts: ['crm.example.com', 'crm.internal'],
    });
  });

  it('rejects invalid allowed origins', () => {
    expect(() => loadAppConfig({ ALLOWED_ORIGINS: 'crm.example.com' })).toThrow(
      'ALLOWED_ORIGINS',
    );
  });

  it('rejects an invalid idle timeout', () => {
    expect(() =>
      loadAppConfig({ SESSION_IDLE_TIMEOUT_MINUTES: 'soon' }),
    ).toThrow('SESSION_IDLE_TIMEOUT_MINUTES');
    expect(() => loadAppConfig({ SETUP_SCRIPT_TIMEOUT_MINUTES: '0' })).toThrow(
      'SETUP_SCRIPT_TIMEOUT_MINUTES',
    );
  });
});
