import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEV_ORIGINS, loadAppConfig } from './app-config';

describe('loadAppConfig', () => {
  it('uses development defaults outside the image', () => {
    const devData = join(homedir(), '.local/share/claude-remote-manager');
    expect(loadAppConfig({})).toEqual({
      dbDir: resolve('data/db'),
      sessionCwd: join(devData, 'projects', 'scratch'),
      sessionAdditionalDirectories: [],
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
        PROJECTS_DIR: '/data/projects',
        SESSION_ADDITIONAL_DIRS: '/data/a: /data/b :',
        SESSION_IDLE_TIMEOUT_MINUTES: '0',
        CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude',
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: 'https://crm.example.com/, https://other.example:8443',
        ALLOWED_HOSTS: 'crm.example.com,crm.internal',
      }),
    ).toEqual({
      dbDir: '/data/db',
      sessionCwd: '/data/projects/scratch',
      sessionAdditionalDirectories: ['/data/a', '/data/b'],
      sessionIdleTimeoutMs: 0,
      claudeExecutable: '/usr/local/bin/claude',
      allowedOrigins: ['https://crm.example.com', 'https://other.example:8443'],
      allowedHosts: ['crm.example.com', 'crm.internal'],
    });
  });

  it('prefers an explicit session working directory', () => {
    expect(
      loadAppConfig({ PROJECTS_DIR: '/p', SESSION_CWD: '/elsewhere' })
        .sessionCwd,
    ).toBe('/elsewhere');
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
  });
});
