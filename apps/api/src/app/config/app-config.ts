import { homedir } from 'node:os';
import { normalizeTeamDomain } from '../auth/access-jwt';
import { AUTH_MODES, type AuthConfig } from '../auth/authenticator';
import {
  ISOLATION_MODES,
  lookupUser,
  type ProcessIsolation,
} from '../common/process-isolation';
import { join, resolve } from 'node:path';

/** Settings of the API, read from the environment once at startup. */
export interface AppConfig {
  /** Directory of the SQLite database. */
  dbDir: string;
  /**
   * The API's own files next to the database: images attached to messages
   * and snapshots of files Claude showed. Sessions cannot write there.
   */
  filesDir: string;
  /**
   * Volume with everything sessions work on. Its subdirectories must be on
   * one filesystem, so that session clones hardlink the mirrors' objects.
   */
  workspaceDir: string;
  /** Mirrors (bare): `<reposDir>/<owner>/<name>`; local projects: `local/<name>`. */
  reposDir: string;
  /** Session clones: `<sessionsDir>/<session-slug>/<owner>/<name>`. */
  sessionsDir: string;
  /** Scratch directories of sessions without repository: `<scratchDir>/<slug>`. */
  scratchDir: string;
  /** Setup scripts are stopped after this many ms. */
  setupScriptTimeoutMs: number;
  /** Close idle Claude Code processes after this many ms; 0 keeps them. */
  sessionIdleTimeoutMs: number;
  /** Claude Code executable; `null` uses the one bundled with the Agent SDK. */
  claudeExecutable: string | null;
  /** Origins besides the server's own that may call the API. */
  allowedOrigins: string[];
  /** Host names besides the loopback names the server answers to. */
  allowedHosts: string[];
  /**
   * URL under which processes on this machine reach the API; its port is
   * never forwarded as a preview.
   */
  internalApiUrl: string;
  /**
   * File whose text is appended to Claude Code's system prompt in every
   * session (`SESSION_INSTRUCTIONS_FILE`, the NixOS module's description of
   * the machine); `null` for none.
   */
  sessionInstructionsFile: string | null;
  /**
   * Claude Code configuration directory of an earlier version of the
   * NixOS module (`LEGACY_CLAUDE_CONFIG_DIR`): transcripts of sessions
   * created back then are copied from there into the current one at
   * startup, see `migrateLegacyTranscripts`. `null` for none.
   */
  legacyClaudeConfigDir: string | null;
  /**
   * `GIT_CONFIG_GLOBAL` of the API's own git commands on mirrors
   * (`API_GIT_CONFIG_GLOBAL`), so that the user's global settings (URL
   * rewrites, signing, credential helpers) do not change them while
   * sessions and git in session clones use the user's own configuration;
   * `null`: the environment's.
   */
  apiGitConfigGlobal: string | null;
  /**
   * Claude Code auto-memory per repository: `<memoryDir>/<owner>/<name>`,
   * shared by all sessions of a repository.
   */
  memoryDir: string;
  /** GitHub App; `null` when not configured. */
  github: GitHubAppConfig | null;
  /** Who runs the session processes, see ProcessIsolation. */
  isolation: ProcessIsolation;
  /** How requests are authenticated, see Authenticator. */
  auth: AuthConfig;
  /** Notifications (Web Push, ntfy). */
  notifications: NotificationsConfig;
  /** PR automation: webhook and polling. */
  prAutomation: PrAutomationConfig;
  /** Previews of dev servers; `null` when `PREVIEW_URL` is not set. */
  previews: PreviewConfig | null;
}

/**
 * Previews of dev servers (`PREVIEW_URL`): every preview gets a host name
 * of its own below `domain`, `<label>.<domain>`, served by this server
 * (the tunnel routes the wildcard name to it). Nothing of the app is
 * served on these names, and no preview on the app's.
 */
export interface PreviewConfig {
  /** How the browser reaches preview hosts. */
  scheme: 'http' | 'https';
  /** Parent domain of the preview host names, e.g. `preview.example.com`. */
  domain: string;
  /** Port in preview URLs; `null` for the scheme's default port. */
  port: number | null;
  /**
   * With `AUTH_MODE=cloudflare-access`: Application Audience tag(s) of the
   * Access application in front of the preview hosts. Never one of the
   * app's own (`CF_ACCESS_AUD`): a preview page must not get a token that
   * the API accepts. Empty with `AUTH_MODE=none`.
   */
  accessAudiences: string[];
}

/**
 * Where the PR automation learns about pull requests: GitHub webhooks of
 * the GitHub App (signed with a secret that is not part of this object,
 * see `pr-automation/webhook-secret.ts`) and polling.
 */
export interface PrAutomationConfig {
  /** File with the webhook secret; `null` to read the secret variable. */
  webhookSecretFile: string | null;
  /**
   * How often open pull requests with automation are read from GitHub; 0
   * turns polling off. `null`: 2 minutes without a webhook secret, 15
   * minutes (as backstop for lost deliveries) with one.
   */
  pollIntervalMs: number | null;
  /**
   * GitHub logins of bots (e.g. `my-reviewer[bot]`) whose reviews and
   * comments count like those of people with write access: they start
   * autofix runs, and their approvals count for "ready to merge".
   */
  trustedBots: string[];
}

/** Secret variable with the GitHub webhook secret, as alternative to a file. */
export const WEBHOOK_SECRET_VARIABLE = 'CRM_SECRET_GITHUB_WEBHOOK_SECRET';

/**
 * Configuration of the notifications. Secrets (the ntfy token, the VAPID
 * private key) are not part of it: they are read from their files or
 * `CRM_SECRET_*` variables by the channels (see notifications/), so they
 * cannot end up in logs or dumps of the configuration.
 */
export interface NotificationsConfig {
  /**
   * Public URL of the web app (`PUBLIC_URL`), e.g. `https://crm.example.com`:
   * ntfy messages link to the session there. `null` without.
   */
  publicUrl: string | null;
  /** A running turn without events for this long hangs; 0 never. */
  stallMs: number;
  /** ntfy server and topic; `null` when ntfy is not configured. */
  ntfy: NtfyConfig | null;
  /** VAPID keys from the environment instead of the generated ones. */
  vapid: VapidConfig;
}

export interface NtfyConfig {
  /** Base URL of the server, without trailing slash. */
  server: string;
  topic: string;
  /** File with the access token; `null` to read `CRM_SECRET_NTFY_TOKEN`. */
  tokenFile: string | null;
}

export interface VapidConfig {
  /** Public key (base64url); with it the private key must be given too. */
  publicKey: string | null;
  /** File with the private key; `null` to read `CRM_SECRET_VAPID_PRIVATE_KEY`. */
  privateKeyFile: string | null;
  /** `mailto:` or `https:` contact of the sender, see RFC 8292. */
  subject: string | null;
}

/** Secret variable with the ntfy access token, as alternative to a file. */
export const NTFY_TOKEN_VARIABLE = 'CRM_SECRET_NTFY_TOKEN';
/** Secret variable with the VAPID private key, as alternative to a file. */
export const VAPID_PRIVATE_KEY_VARIABLE = 'CRM_SECRET_VAPID_PRIVATE_KEY';

/**
 * GitHub App settings. The private key itself is not part of the
 * configuration object: it is read from `privateKeyFile` or from the
 * secret variable `CRM_SECRET_GITHUB_APP_PRIVATE_KEY` (see
 * github/github-app-credentials.ts), so it cannot end up in logs or dumps
 * of the configuration.
 */
export interface GitHubAppConfig {
  /** App ID (numeric), used as JWT issuer. */
  appId: string;
  /** File with the PEM private key; `null` to read it from the secret variable. */
  privateKeyFile: string | null;
}

/** The Angular dev server, allowed outside production. */
export const DEV_ORIGINS = ['http://localhost:4200', 'http://127.0.0.1:4200'];

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

export const APP_CONFIG = Symbol('APP_CONFIG');

type Env = Record<string, string | undefined>;

/**
 * Reads the configuration. Inside the image all directories come from the
 * environment (see Dockerfile). For local development the defaults keep the
 * database in the gitignored `data/` directory of this repository and the
 * session workspace (mirrors, session clones, scratch directories) outside
 * of it, so Claude never works inside this repository.
 */
export function loadAppConfig(
  env: Env = process.env,
  passwd?: string,
): AppConfig {
  const value = (name: string) => env[name]?.trim() || undefined;
  const devDataDir = join(homedir(), '.local/share/claude-remote-manager');
  const dir = (name: string, fallback: string) =>
    resolve(value(name) ?? join(devDataDir, fallback));
  const minutes = (name: string, fallback: number, min: number) => {
    const result = Number(value(name) ?? fallback);
    if (!Number.isFinite(result) || result < min) {
      throw new Error(`${name} must be a number >= ${min}`);
    }
    return result * 60_000;
  };
  const workspaceDir = dir('WORKSPACE_DIR', 'workspace');
  const port = value('PORT') ?? '3000';
  const claudeConfigDir = value('CLAUDE_CONFIG_DIR');
  const appId = value('GITHUB_APP_ID');
  if (appId !== undefined && !/^\d+$/.test(appId)) {
    throw new Error('GITHUB_APP_ID must be the numeric App ID');
  }
  const dbDir = resolve(value('DB_DIR') ?? 'data/db');
  const auth = loadAuth(value);
  return {
    dbDir,
    filesDir: resolve(value('FILES_DIR') ?? join(dbDir, 'files')),
    ...workspaceLayout(workspaceDir),
    setupScriptTimeoutMs: minutes('SETUP_SCRIPT_TIMEOUT_MINUTES', 15, 0.1),
    sessionIdleTimeoutMs: minutes('SESSION_IDLE_TIMEOUT_MINUTES', 60, 0),
    claudeExecutable: value('CLAUDE_CODE_EXECUTABLE') ?? null,
    allowedOrigins: [
      ...(env['NODE_ENV'] === 'production' ? [] : DEV_ORIGINS),
      ...list(value('ALLOWED_ORIGINS')).map((origin) => {
        try {
          return new URL(origin).origin;
        } catch {
          throw new Error(`ALLOWED_ORIGINS: ${origin} is not a URL`);
        }
      }),
    ],
    allowedHosts: list(value('ALLOWED_HOSTS')),
    internalApiUrl: (
      value('INTERNAL_API_URL') ?? `http://127.0.0.1:${port}`
    ).replace(/\/+$/, ''),
    sessionInstructionsFile: value('SESSION_INSTRUCTIONS_FILE')
      ? resolve(value('SESSION_INSTRUCTIONS_FILE') as string)
      : null,
    legacyClaudeConfigDir: value('LEGACY_CLAUDE_CONFIG_DIR')
      ? resolve(value('LEGACY_CLAUDE_CONFIG_DIR') as string)
      : null,
    apiGitConfigGlobal: value('API_GIT_CONFIG_GLOBAL')
      ? resolve(value('API_GIT_CONFIG_GLOBAL') as string)
      : null,
    memoryDir: resolve(
      value('MEMORY_DIR') ??
        (claudeConfigDir
          ? join(claudeConfigDir, 'repository-memory')
          : join(devDataDir, 'memory')),
    ),
    github: appId
      ? {
          appId,
          privateKeyFile: value('GITHUB_APP_PRIVATE_KEY_FILE')
            ? resolve(value('GITHUB_APP_PRIVATE_KEY_FILE') as string)
            : null,
        }
      : null,
    isolation: loadIsolation(
      value('PROCESS_ISOLATION'),
      value('SESSION_USER'),
      value('SESSION_PATH'),
      passwd,
    ),
    auth,
    notifications: loadNotifications(value, minutes),
    prAutomation: loadPrAutomation(value),
    previews: loadPreviews(value, auth),
  };
}

/** Host names that can never be a preview domain (the app's loopback names). */
const RESERVED_PREVIEW_DOMAINS = ['localhost', '127.0.0.1', '::1'];

/** Whether `host` (a host name without port) is `domain` or below it. */
export function withinDomain(host: string, domain: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return name === domain || name.endsWith(`.${domain}`);
}

/**
 * `PREVIEW_URL`, e.g. `https://preview.example.com` or, locally,
 * `http://preview.localhost:3000`: scheme, parent domain and port of the
 * preview host names. Checked against the app's own host names, so that
 * no host is both.
 */
export function parsePreviewUrl(
  raw: string,
): Omit<PreviewConfig, 'accessAudiences'> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PREVIEW_URL must be an http or https URL');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error(
      'PREVIEW_URL must be an http or https URL with a host name only, e.g. https://preview.example.com',
    );
  }
  const domain = url.hostname.toLowerCase();
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
      domain,
    ) ||
    /^[0-9.]+$/.test(domain) ||
    RESERVED_PREVIEW_DOMAINS.includes(domain)
  ) {
    throw new Error(
      `PREVIEW_URL: ${domain} must be a domain name with at least two labels (not an IP address or localhost), e.g. preview.example.com or preview.localhost`,
    );
  }
  return {
    scheme: url.protocol === 'https:' ? 'https' : 'http',
    domain,
    port: url.port ? Number(url.port) : null,
  };
}

/**
 * The preview configuration, checked against the rest: the app's host
 * names must lie outside the preview domain, and with Cloudflare Access the
 * preview hosts need an Access application of their own.
 */
function loadPreviews(
  value: (name: string) => string | undefined,
  auth: AuthConfig,
): PreviewConfig | null {
  const raw = value('PREVIEW_URL');
  if (!raw) {
    return null;
  }
  const preview = parsePreviewUrl(raw);
  const appHosts = [
    ...list(value('ALLOWED_HOSTS')),
    ...list(value('ALLOWED_ORIGINS')).map((origin) => new URL(origin).hostname),
    ...(value('PUBLIC_URL')
      ? [new URL(value('PUBLIC_URL') as string).hostname]
      : []),
  ];
  for (const host of appHosts) {
    if (withinDomain(host.replace(/:\d+$/, ''), preview.domain)) {
      throw new Error(
        `PREVIEW_URL: the app's host ${host} lies in the preview domain ${preview.domain}; previews need a domain of their own`,
      );
    }
  }
  let accessAudiences: string[] = [];
  if (auth.mode === 'cloudflare-access') {
    accessAudiences = list(value('PREVIEW_ACCESS_AUD'));
    if (accessAudiences.length === 0) {
      throw new Error(
        'PREVIEW_URL with AUTH_MODE=cloudflare-access needs PREVIEW_ACCESS_AUD: the audience tag of the Access application in front of the preview hosts',
      );
    }
    if (accessAudiences.some((aud) => auth.access.audiences.includes(aud))) {
      throw new Error(
        'PREVIEW_ACCESS_AUD must differ from CF_ACCESS_AUD: previews need an Access application of their own, or a preview page could use its token against the API',
      );
    }
  }
  return { ...preview, accessAudiences };
}

/** Shortest polling interval that can be configured. */
export const MIN_POLL_INTERVAL_SECONDS = 30;

function loadPrAutomation(
  value: (name: string) => string | undefined,
): PrAutomationConfig {
  const file = value('GITHUB_WEBHOOK_SECRET_FILE');
  const interval = value('PR_POLL_INTERVAL_SECONDS');
  let pollIntervalMs: number | null = null;
  if (interval !== undefined) {
    const seconds = Number(interval);
    if (
      !Number.isInteger(seconds) ||
      (seconds !== 0 && seconds < MIN_POLL_INTERVAL_SECONDS)
    ) {
      throw new Error(
        `PR_POLL_INTERVAL_SECONDS must be 0 (off) or a whole number >= ${MIN_POLL_INTERVAL_SECONDS}`,
      );
    }
    pollIntervalMs = seconds * 1000;
  }
  const trustedBots = list(value('PR_TRUSTED_BOTS'));
  for (const login of trustedBots) {
    if (!TRUSTED_BOT_LOGIN.test(login)) {
      throw new Error(
        `PR_TRUSTED_BOTS must list GitHub logins of bots ending in [bot], e.g. my-reviewer[bot]; got ${JSON.stringify(login)}`,
      );
    }
  }
  return {
    webhookSecretFile: file ? resolve(file) : null,
    pollIntervalMs,
    trustedBots,
  };
}

/** A bot's GitHub login, as reviews and comments name their author. */
const TRUSTED_BOT_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\[bot\]$/;

/** `http(s)` URL without trailing slash, or an error naming the variable. */
function httpUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an http or https URL`);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${name} must be an http or https URL without credentials, query or fragment`,
    );
  }
  return url.href.replace(/\/+$/, '');
}

/** ntfy topics: letters, digits, `_` and `-`, at most 64 characters. */
const NTFY_TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function loadNotifications(
  value: (name: string) => string | undefined,
  minutes: (name: string, fallback: number, min: number) => number,
): NotificationsConfig {
  const publicUrl = value('PUBLIC_URL');
  const ntfyUrl = value('NTFY_URL');
  const topic = value('NTFY_TOPIC');
  let ntfy: NtfyConfig | null = null;
  if (ntfyUrl || topic) {
    if (!ntfyUrl || !topic) {
      throw new Error('ntfy needs both NTFY_URL and NTFY_TOPIC');
    }
    if (!NTFY_TOPIC_PATTERN.test(topic)) {
      throw new Error(
        'NTFY_TOPIC may only contain letters, digits, _ and - (at most 64)',
      );
    }
    const tokenFile = value('NTFY_TOKEN_FILE');
    if (!tokenFile && !value(NTFY_TOKEN_VARIABLE)) {
      throw new Error(
        `ntfy needs an access token: set NTFY_TOKEN_FILE or ${NTFY_TOKEN_VARIABLE}`,
      );
    }
    ntfy = {
      server: httpUrl('NTFY_URL', ntfyUrl),
      topic,
      tokenFile: tokenFile ? resolve(tokenFile) : null,
    };
  }
  const subject = value('VAPID_SUBJECT');
  if (subject && !/^(mailto:|https:\/\/)/.test(subject)) {
    throw new Error('VAPID_SUBJECT must be a mailto: or https: URL');
  }
  const vapidFile = value('VAPID_PRIVATE_KEY_FILE');
  return {
    publicUrl: publicUrl ? httpUrl('PUBLIC_URL', publicUrl) : null,
    stallMs: minutes('SESSION_STALL_MINUTES', 15, 0),
    ntfy,
    vapid: {
      publicKey: value('VAPID_PUBLIC_KEY') ?? null,
      privateKeyFile: vapidFile ? resolve(vapidFile) : null,
      subject: subject ?? null,
    },
  };
}

/** `AUTH_MODE` has no default either: `none` must be chosen explicitly. */
function loadAuth(value: (name: string) => string | undefined): AuthConfig {
  const mode = value('AUTH_MODE');
  if (mode === 'none') {
    return { mode };
  }
  if (mode === 'cloudflare-access') {
    const team = value('CF_ACCESS_TEAM_DOMAIN');
    const audiences = list(value('CF_ACCESS_AUD'));
    if (!team || audiences.length === 0) {
      throw new Error(
        'AUTH_MODE=cloudflare-access needs CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD',
      );
    }
    return {
      mode,
      access: {
        teamDomain: normalizeTeamDomain(team),
        audiences,
        allowedEmails: list(value('CF_ACCESS_ALLOWED_EMAILS')).map((email) =>
          email.toLowerCase(),
        ),
      },
    };
  }
  throw new Error(
    `AUTH_MODE must be set to ${AUTH_MODES.join(' or ')} (none only for local development: the API is then unauthenticated)`,
  );
}

/**
 * `PROCESS_ISOLATION` has no default: the image sets `separate-users`, the
 * NixOS module `single-user`, local development has to choose
 * `single-user` explicitly.
 */
function loadIsolation(
  mode: string | undefined,
  sessionUser: string | undefined,
  sessionPath: string | undefined,
  passwd?: string,
): ProcessIsolation {
  if (mode === 'single-user') {
    return { mode, ...(sessionPath ? { sessionPath } : {}) };
  }
  if (mode === 'separate-users') {
    return {
      mode,
      sessionUser: lookupUser(sessionUser ?? 'claude', passwd),
      ...(sessionPath ? { sessionPath } : {}),
    };
  }
  throw new Error(
    `PROCESS_ISOLATION must be set to ${ISOLATION_MODES.join(' or ')}`,
  );
}

/** Configuration for tests: everything below `dir`, no GitHub App. */
export function testAppConfig(
  dir: string,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  return {
    dbDir: ':memory:',
    filesDir: join(dir, 'files'),
    ...workspaceLayout(join(dir, 'workspace')),
    setupScriptTimeoutMs: 10_000,
    sessionIdleTimeoutMs: 0,
    claudeExecutable: null,
    allowedOrigins: [],
    allowedHosts: [],
    internalApiUrl: 'http://127.0.0.1:3000',
    sessionInstructionsFile: null,
    legacyClaudeConfigDir: null,
    apiGitConfigGlobal: null,
    memoryDir: join(dir, 'memory'),
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
      pollIntervalMs: 0,
      trustedBots: [],
    },
    previews: null,
    ...overrides,
  };
}

/** The fixed subdirectories of the workspace directory. */
export function workspaceLayout(
  workspaceDir: string,
): Pick<AppConfig, 'workspaceDir' | 'reposDir' | 'sessionsDir' | 'scratchDir'> {
  return {
    workspaceDir,
    reposDir: join(workspaceDir, 'repos'),
    sessionsDir: join(workspaceDir, 'sessions'),
    scratchDir: join(workspaceDir, 'scratch'),
  };
}
