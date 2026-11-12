import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Settings of the API, read from the environment once at startup. */
export interface AppConfig {
  /** Directory of the SQLite database. */
  dbDir: string;
  /** Working directory of new sessions (fixed until worktrees exist). */
  sessionCwd: string;
  /** Additional directories every new session may access. */
  sessionAdditionalDirectories: string[];
  /** Close idle Claude Code processes after this many ms; 0 keeps them. */
  sessionIdleTimeoutMs: number;
  /** Claude Code executable; `null` uses the one bundled with the Agent SDK. */
  claudeExecutable: string | null;
  /** Origins besides the server's own that may call the API. */
  allowedOrigins: string[];
  /** Host names besides the loopback names the server answers to. */
  allowedHosts: string[];
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
 * database in the gitignored `data/` directory of the workspace and the
 * session working directory outside of it, so Claude never works inside
 * this repository.
 */
export function loadAppConfig(env: Env = process.env): AppConfig {
  const value = (name: string) => env[name]?.trim() || undefined;
  const devDataDir = join(homedir(), '.local/share/claude-remote-manager');
  const projectsDir = resolve(
    value('PROJECTS_DIR') ?? join(devDataDir, 'projects'),
  );
  const idleMinutes = Number(value('SESSION_IDLE_TIMEOUT_MINUTES') ?? 60);
  if (!Number.isFinite(idleMinutes) || idleMinutes < 0) {
    throw new Error('SESSION_IDLE_TIMEOUT_MINUTES must be a number >= 0');
  }
  return {
    dbDir: resolve(value('DB_DIR') ?? 'data/db'),
    sessionCwd: resolve(value('SESSION_CWD') ?? join(projectsDir, 'scratch')),
    sessionAdditionalDirectories: (value('SESSION_ADDITIONAL_DIRS') ?? '')
      .split(':')
      .map((dir) => dir.trim())
      .filter(Boolean)
      .map((dir) => resolve(dir)),
    sessionIdleTimeoutMs: idleMinutes * 60_000,
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
  };
}
