import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadAppConfig } from './app-config';

describe('loadAppConfig', () => {
  it('uses development defaults outside the image', () => {
    const devData = join(homedir(), '.local/share/claude-remote-manager');
    expect(loadAppConfig({})).toEqual({
      dbDir: resolve('data/db'),
      sessionCwd: join(devData, 'projects', 'scratch'),
      sessionAdditionalDirectories: [],
      sessionIdleTimeoutMs: 60 * 60_000,
      claudeExecutable: null,
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
      }),
    ).toEqual({
      dbDir: '/data/db',
      sessionCwd: '/data/projects/scratch',
      sessionAdditionalDirectories: ['/data/a', '/data/b'],
      sessionIdleTimeoutMs: 0,
      claudeExecutable: '/usr/local/bin/claude',
    });
  });

  it('prefers an explicit session working directory', () => {
    expect(
      loadAppConfig({ PROJECTS_DIR: '/p', SESSION_CWD: '/elsewhere' })
        .sessionCwd,
    ).toBe('/elsewhere');
  });

  it('rejects an invalid idle timeout', () => {
    expect(() =>
      loadAppConfig({ SESSION_IDLE_TIMEOUT_MINUTES: 'soon' }),
    ).toThrow('SESSION_IDLE_TIMEOUT_MINUTES');
  });
});
