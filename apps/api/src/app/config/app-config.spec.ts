import { resolveCodexExecutable } from '../agent/codex/codex-home';
import { homedir, tmpdir } from 'node:os';
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

  it('reads the commit identity: both variables or neither', () => {
    expect(
      loadAppConfig({
        ...DEV,
        CRM_GIT_AUTHOR_NAME: ' Ada Lovelace ',
        CRM_GIT_AUTHOR_EMAIL: 'ada@example.com',
      }).gitIdentity,
    ).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(
      loadAppConfig({
        ...DEV,
        CRM_GIT_AUTHOR_NAME: '',
        CRM_GIT_AUTHOR_EMAIL: ' ',
      }).gitIdentity,
    ).toBeNull();
    for (const [env, message] of [
      [{ CRM_GIT_AUTHOR_NAME: 'Ada' }, 'or neither'],
      [{ CRM_GIT_AUTHOR_EMAIL: 'a@b.c' }, 'or neither'],
      [
        { CRM_GIT_AUTHOR_NAME: 'A <b>', CRM_GIT_AUTHOR_EMAIL: 'a@b.c' },
        'without <',
      ],
      [
        { CRM_GIT_AUTHOR_NAME: 'Line\nbreak', CRM_GIT_AUTHOR_EMAIL: 'a@b.c' },
        'control characters',
      ],
      [
        { CRM_GIT_AUTHOR_NAME: '...', CRM_GIT_AUTHOR_EMAIL: 'a@b.c' },
        'not only punctuation',
      ],
      [
        { CRM_GIT_AUTHOR_NAME: 'A', CRM_GIT_AUTHOR_EMAIL: 'not-an-email' },
        'CRM_GIT_AUTHOR_EMAIL is not an email address',
      ],
    ] as const) {
      expect(() => loadAppConfig({ ...DEV, ...env })).toThrow(message);
    }
  });

  it('reads the session PATH for separate users', () => {
    const env = { ...DEV, PROCESS_ISOLATION: 'separate-users' };
    expect(
      loadAppConfig(
        { ...env, SESSION_PATH: '/home/claude/.nix-profile/bin:/bin' },
        PASSWD,
      ).isolation,
    ).toMatchObject({ sessionPath: '/home/claude/.nix-profile/bin:/bin' });
    expect(loadAppConfig(env, PASSWD).isolation).not.toHaveProperty(
      'sessionPath',
    );
  });

  it('uses development defaults outside the image', () => {
    const devData = join(homedir(), '.local/share/claude-remote-manager');
    expect(loadAppConfig(DEV)).toEqual({
      dbDir: resolve('data/db'),
      environmentKeyFile: resolve('data/db/environment.key'),
      environmentFilesDir: join(tmpdir(), 'crm-environment-files'),
      filesDir: resolve('data/db/files'),
      workspaceDir: join(devData, 'workspace'),
      reposDir: join(devData, 'workspace', 'repos'),
      sessionsDir: join(devData, 'workspace', 'sessions'),
      scratchDir: join(devData, 'workspace', 'scratch'),
      setupScriptTimeoutMs: 15 * 60_000,
      sessionIdleTimeoutMs: 60 * 60_000,
      claudeExecutable: null,
      codexExecutable: resolveCodexExecutable(null, DEV),
      allowedOrigins: DEV_ORIGINS,
      allowedHosts: [],
      internalApiUrl: 'http://127.0.0.1:3000',
      sessionInstructionsFile: null,
      legacyClaudeConfigDir: null,
      apiGitConfigGlobal: null,
      memoryDir: join(devData, 'memory'),
      gitIdentity: null,
      github: null,
      isolation: { mode: 'single-user' },
      auth: { mode: 'none' },
      notifications: {
        publicUrl: null,
        stallMs: 15 * 60_000,
        ntfy: null,
        vapid: { publicKey: null, privateKeyFile: null, subject: null },
      },
      prAutomation: {
        webhookSecretFile: null,
        pollIntervalMs: null,
        trustedBots: [],
      },
      previews: null,
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
          CODEX_EXECUTABLE: '/usr/local/bin/codex',
          NODE_ENV: 'production',
          ALLOWED_ORIGINS:
            'https://crm.example.com/, https://other.example:8443',
          ALLOWED_HOSTS: 'crm.example.com,crm.internal',
          PORT: '8080',
          CLAUDE_CONFIG_DIR: '/data/claude',
          CRM_GIT_AUTHOR_NAME: 'Jane Doe',
          CRM_GIT_AUTHOR_EMAIL: 'jane@example.com',
          GITHUB_APP_ID: '12345',
          GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/github-app-key',
          PROCESS_ISOLATION: 'separate-users',
          AUTH_MODE: 'cloudflare-access',
          CF_ACCESS_TEAM_DOMAIN: 'acme',
          CF_ACCESS_AUD: 'aud-1, aud-2',
          CF_ACCESS_ALLOWED_EMAILS: 'Ada@Example.com',
          PUBLIC_URL: 'https://crm.example.com/',
          SESSION_STALL_MINUTES: '20',
          NTFY_URL: 'https://ntfy.example.com',
          NTFY_TOPIC: 'crm-alerts',
          NTFY_TOKEN_FILE: '/run/secrets/ntfy-token',
          VAPID_SUBJECT: 'mailto:admin@example.com',
          GITHUB_WEBHOOK_SECRET_FILE: '/run/secrets/github-webhook-secret',
          PR_POLL_INTERVAL_SECONDS: '300',
          PR_TRUSTED_BOTS: 'my-reviewer[bot], ci-helper[bot]',
        },
        PASSWD,
      ),
    ).toEqual({
      dbDir: '/data/db',
      environmentKeyFile: '/data/db/environment.key',
      environmentFilesDir: join(tmpdir(), 'crm-environment-files'),
      filesDir: '/data/db/files',
      workspaceDir: '/data/workspace',
      reposDir: '/data/workspace/repos',
      sessionsDir: '/data/workspace/sessions',
      scratchDir: '/data/workspace/scratch',
      setupScriptTimeoutMs: 5 * 60_000,
      sessionIdleTimeoutMs: 0,
      claudeExecutable: '/usr/local/bin/claude',
      codexExecutable: '/usr/local/bin/codex',
      allowedOrigins: ['https://crm.example.com', 'https://other.example:8443'],
      allowedHosts: ['crm.example.com', 'crm.internal'],
      internalApiUrl: 'http://127.0.0.1:8080',
      sessionInstructionsFile: null,
      legacyClaudeConfigDir: null,
      apiGitConfigGlobal: null,
      memoryDir: '/data/claude/repository-memory',
      gitIdentity: { name: 'Jane Doe', email: 'jane@example.com' },
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
      notifications: {
        publicUrl: 'https://crm.example.com',
        stallMs: 20 * 60_000,
        ntfy: {
          server: 'https://ntfy.example.com',
          topic: 'crm-alerts',
          tokenFile: '/run/secrets/ntfy-token',
        },
        vapid: {
          publicKey: null,
          privateKeyFile: null,
          subject: 'mailto:admin@example.com',
        },
      },
      prAutomation: {
        webhookSecretFile: '/run/secrets/github-webhook-secret',
        pollIntervalMs: 300_000,
        trustedBots: ['my-reviewer[bot]', 'ci-helper[bot]'],
      },
      previews: null,
    });
  });

  it('accepts polling intervals of 0 (off) and from 30 seconds', () => {
    expect(
      loadAppConfig({ ...DEV, PR_POLL_INTERVAL_SECONDS: '0' }).prAutomation
        .pollIntervalMs,
    ).toBe(0);
    for (const value of ['10', '-5', '1.5', 'often']) {
      expect(() =>
        loadAppConfig({ ...DEV, PR_POLL_INTERVAL_SECONDS: value }),
      ).toThrow('PR_POLL_INTERVAL_SECONDS');
    }
  });

  it('accepts only bot logins as trusted bots', () => {
    for (const value of ['someone', 'my-reviewer', '[bot]', 'a b[bot]']) {
      expect(() => loadAppConfig({ ...DEV, PR_TRUSTED_BOTS: value })).toThrow(
        'PR_TRUSTED_BOTS',
      );
    }
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

  it('checks the notification settings', () => {
    const ntfy = {
      ...DEV,
      NTFY_URL: 'https://ntfy.example.com/',
      NTFY_TOPIC: 'crm',
    };
    // The token is required whenever ntfy is configured.
    expect(() => loadAppConfig(ntfy)).toThrow('ntfy needs an access token');
    expect(
      loadAppConfig({ ...ntfy, CRM_SECRET_NTFY_TOKEN: 'tk_secret' })
        .notifications.ntfy,
    ).toEqual({
      server: 'https://ntfy.example.com',
      topic: 'crm',
      tokenFile: null,
    });
    // ...and the token never becomes part of the configuration.
    expect(
      JSON.stringify(
        loadAppConfig({ ...ntfy, CRM_SECRET_NTFY_TOKEN: 'tk_secret' }),
      ),
    ).not.toContain('tk_secret');
    expect(() =>
      loadAppConfig({ ...DEV, NTFY_URL: 'https://ntfy.example.com' }),
    ).toThrow('both NTFY_URL and NTFY_TOPIC');
    expect(() =>
      loadAppConfig({
        ...ntfy,
        NTFY_TOPIC: 'a/b',
        CRM_SECRET_NTFY_TOKEN: 'x',
      }),
    ).toThrow('NTFY_TOPIC');
    expect(() =>
      loadAppConfig({
        ...ntfy,
        NTFY_URL: 'https://user:pw@ntfy.example.com',
        CRM_SECRET_NTFY_TOKEN: 'x',
      }),
    ).toThrow('NTFY_URL');
    expect(() =>
      loadAppConfig({ ...DEV, PUBLIC_URL: 'crm.example.com' }),
    ).toThrow('PUBLIC_URL');
    expect(() =>
      loadAppConfig({ ...DEV, VAPID_SUBJECT: 'admin@example.com' }),
    ).toThrow('VAPID_SUBJECT');
    expect(
      loadAppConfig({ ...DEV, SESSION_STALL_MINUTES: '0' }).notifications
        .stallMs,
    ).toBe(0);
  });

  it('rejects an invalid idle timeout', () => {
    expect(() =>
      loadAppConfig({ ...DEV, SESSION_IDLE_TIMEOUT_MINUTES: 'soon' }),
    ).toThrow('SESSION_IDLE_TIMEOUT_MINUTES');
    expect(() =>
      loadAppConfig({ ...DEV, SETUP_SCRIPT_TIMEOUT_MINUTES: '0' }),
    ).toThrow('SETUP_SCRIPT_TIMEOUT_MINUTES');
  });

  describe('previews', () => {
    const ACCESS = {
      AUTH_MODE: 'cloudflare-access',
      PROCESS_ISOLATION: 'single-user',
      CF_ACCESS_TEAM_DOMAIN: 'acme',
      CF_ACCESS_AUD: 'app-aud',
    };

    it('are off without PREVIEW_URL and read it otherwise', () => {
      expect(loadAppConfig(DEV).previews).toBeNull();
      expect(
        loadAppConfig({ ...DEV, PREVIEW_URL: 'http://preview.localhost:3000' })
          .previews,
      ).toEqual({
        scheme: 'http',
        domain: 'preview.localhost',
        port: 3000,
        accessAudiences: [],
      });
      expect(
        loadAppConfig({
          ...ACCESS,
          PREVIEW_URL: 'https://Preview.Example.com/',
          PREVIEW_ACCESS_AUD: 'preview-aud',
        }).previews,
      ).toEqual({
        scheme: 'https',
        domain: 'preview.example.com',
        port: null,
        accessAudiences: ['preview-aud'],
      });
    });

    it('take a domain name only', () => {
      for (const url of [
        'preview.example.com',
        'ftp://preview.example.com',
        'https://preview.example.com/path',
        'https://user@preview.example.com',
        'https://localhost',
        'http://127.0.0.1:3000',
        'https://com',
      ]) {
        expect(() => loadAppConfig({ ...DEV, PREVIEW_URL: url })).toThrow(
          'PREVIEW_URL',
        );
      }
    });

    it('keep the app’s host names out of the preview domain', () => {
      for (const env of [
        { ALLOWED_HOSTS: 'crm.preview.example.com' },
        { ALLOWED_HOSTS: 'preview.example.com' },
        { ALLOWED_ORIGINS: 'https://x.preview.example.com' },
        { PUBLIC_URL: 'https://a.preview.example.com' },
      ]) {
        expect(() =>
          loadAppConfig({
            ...DEV,
            PREVIEW_URL: 'https://preview.example.com',
            ...env,
          }),
        ).toThrow('lies in the preview domain');
      }
      expect(
        loadAppConfig({
          ...DEV,
          PREVIEW_URL: 'https://preview.example.com',
          ALLOWED_HOSTS: 'crm.example.com',
          PUBLIC_URL: 'https://crm.example.com',
        }).previews?.domain,
      ).toBe('preview.example.com');
    });

    it('need an Access application of their own with Cloudflare Access', () => {
      expect(() =>
        loadAppConfig({
          ...ACCESS,
          PREVIEW_URL: 'https://preview.example.com',
        }),
      ).toThrow('needs PREVIEW_ACCESS_AUD');
      expect(() =>
        loadAppConfig({
          ...ACCESS,
          PREVIEW_URL: 'https://preview.example.com',
          PREVIEW_ACCESS_AUD: 'other, app-aud',
        }),
      ).toThrow('PREVIEW_ACCESS_AUD must differ from CF_ACCESS_AUD');
    });
  });
});
