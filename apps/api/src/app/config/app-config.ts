import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Settings of the API, read from the environment once at startup. */
export interface AppConfig {
  /** Directory of the SQLite database. */
  dbDir: string;
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
   * URL under which processes on this machine reach the API (the git
   * credential helper of session clones).
   */
  internalApiUrl: string;
  /**
   * Claude Code auto-memory per repository: `<memoryDir>/<owner>/<name>`,
   * shared by all sessions of a repository.
   */
  memoryDir: string;
  /** GitHub App; `null` when not configured. */
  github: GitHubAppConfig | null;
}

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
export function loadAppConfig(env: Env = process.env): AppConfig {
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
  return {
    dbDir: resolve(value('DB_DIR') ?? 'data/db'),
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
  };
}

/** Configuration for tests: everything below `dir`, no GitHub App. */
export function testAppConfig(
  dir: string,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  return {
    dbDir: ':memory:',
    ...workspaceLayout(join(dir, 'workspace')),
    setupScriptTimeoutMs: 10_000,
    sessionIdleTimeoutMs: 0,
    claudeExecutable: null,
    allowedOrigins: [],
    allowedHosts: [],
    internalApiUrl: 'http://127.0.0.1:3000',
    memoryDir: join(dir, 'memory'),
    github: null,
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
