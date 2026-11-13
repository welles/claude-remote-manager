import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEV_ORIGINS, loadAppConfig } from './app-config';

const DEV = { AUTH_MODE: 'none', PROCESS_ISOLATION: 'single-user' };
const PASSWD =
  'root:x:0:0:root:/root:/bin/bash\ncrm:x:1000:1000::/home/crm:/bin/sh\nclaude:x:1001:1001::/home/claude:/bin/bash\n';

describe('loadAppConfig', () => {
  it('has no default for the auth mode and the process isolation', () => {
    expect(() => loadAppConfig({ PROCESS_ISOLATION: 'single-user' })).toThrow(
      'AUTH_MODE must be set',
    );
    expect(() => loadAppConfig({ AUTH_MODE: 'none' })).toThrow(
      'PROCESS_ISOLATION must be set',
    );
    expect(() =>
      loadAppConfig({ ...DEV, AUTH_MODE: 'cloudflare-access' }),
    ).toThrow('CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD');
    expect(() =>
      loadAppConfig(
        {
          ...DEV,
          PROCESS_ISOLATION: 'separate-users',
          SESSION_USER: 'nobody2',
        },
        PASSWD,
      ),
    ).toThrow('session user nobody2 does not exist');
  });

  it('uses development defaults outside the image', () => {
    const devData = join(homedir(), '.local/share/claude-remote-manager');
    expect(loadAppConfig(DEV)).toEqual({
      dbDir: resolve('data/db'),
      workspaceDir: join(devData, 'workspace'),
      reposDir: join(devData, 'workspace', 'repos'),
      sessionsDir: join(devData, 'workspace', 'sessions'),
      scratchDir: join(devData, 'workspace', 'scratch'),
      setupScriptTimeoutMs: 15 * 60_000,
      sessionIdleTimeoutMs: 60 * 60_000,
      claudeExecutable: null,
      allowedOrigins: DEV_ORIGINS,
      allowedHosts: [],
      internalApiUrl: 'http://127.0.0.1:3000',
      memoryDir: join(devData, 'memory'),
      github: null,
      isolation: { mode: 'single-user' },
      auth: { mode: 'none' },
    });
  });

  it('reads the image environment', () => {
    expect(
      loadAppConfig(
        {
          DB_DIR: '/data/db',
          WORKSPACE_DIR: '/data/workspace/',
          SETUP_SCRIPT_TIMEOUT_MINUTES: '5',
          SESSION_IDLE_TIMEOUT_MINUTES: '0',
          CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude',
          NODE_ENV: 'production',
          ALLOWED_ORIGINS:
            'https://crm.example.com/, https://other.example:8443',
          ALLOWED_HOSTS: 'crm.example.com,crm.internal',
          PORT: '8080',
          CLAUDE_CONFIG_DIR: '/data/claude',
          GITHUB_APP_ID: '12345',
          GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/github-app-key',
          PROCESS_ISOLATION: 'separate-users',
          AUTH_MODE: 'cloudflare-access',
          CF_ACCESS_TEAM_DOMAIN: 'acme',
          CF_ACCESS_AUD: 'aud-1, aud-2',
          CF_ACCESS_ALLOWED_EMAILS: 'Ada@Example.com',
        },
        PASSWD,
      ),
    ).toEqual({
      dbDir: '/data/db',
      workspaceDir: '/data/workspace',
      reposDir: '/data/workspace/repos',
      sessionsDir: '/data/workspace/sessions',
      scratchDir: '/data/workspace/scratch',
      setupScriptTimeoutMs: 5 * 60_000,
      sessionIdleTimeoutMs: 0,
      claudeExecutable: '/usr/local/bin/claude',
      allowedOrigins: ['https://crm.example.com', 'https://other.example:8443'],
      allowedHosts: ['crm.example.com', 'crm.internal'],
      internalApiUrl: 'http://127.0.0.1:8080',
      memoryDir: '/data/claude/repository-memory',
      github: {
        appId: '12345',
        privateKeyFile: '/run/secrets/github-app-key',
      },
      isolation: {
        mode: 'separate-users',
        sessionUser: {
          name: 'claude',
          uid: 1001,
          gid: 1001,
          home: '/home/claude',
        },
      },
      auth: {
        mode: 'cloudflare-access',
        access: {
          teamDomain: 'https://acme.cloudflareaccess.com',
          audiences: ['aud-1', 'aud-2'],
          allowedEmails: ['ada@example.com'],
        },
      },
    });
  });

  it('rejects a GitHub App ID that is not numeric', () => {
    expect(() => loadAppConfig({ ...DEV, GITHUB_APP_ID: 'Iv23abc' })).toThrow(
      'GITHUB_APP_ID',
    );
  });

  it('rejects invalid allowed origins', () => {
    expect(() =>
      loadAppConfig({ ...DEV, ALLOWED_ORIGINS: 'crm.example.com' }),
    ).toThrow('ALLOWED_ORIGINS');
  });

  it('rejects an invalid idle timeout', () => {
    expect(() =>
      loadAppConfig({ ...DEV, SESSION_IDLE_TIMEOUT_MINUTES: 'soon' }),
    ).toThrow('SESSION_IDLE_TIMEOUT_MINUTES');
    expect(() =>
      loadAppConfig({ ...DEV, SETUP_SCRIPT_TIMEOUT_MINUTES: '0' }),
    ).toThrow('SETUP_SCRIPT_TIMEOUT_MINUTES');
  });
});
