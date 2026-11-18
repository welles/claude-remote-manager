/**
 * Environment of every process the app starts: Claude Code, setup
 * scripts, its own git commands (and later dev servers). They inherit the
 * API's environment minus the app's secrets.
 *
 * Secrets are recognized two ways:
 * - by prefix: every variable starting with `CRM_SECRET_` is a secret. New
 *   secrets of the app (GitHub App key, webhook secret, ntfy token, VAPID
 *   key, ...) must use this prefix; then a forgotten registration below
 *   still keeps them away from child processes;
 * - by name: {@link SECRET_VARIABLES} lists secrets whose names are given
 *   by others (e.g. Claude Code's own variables).
 */
export const SECRET_PREFIX = 'CRM_SECRET_';

/** Secrets with fixed names; extend when the app reads another one. */
export const SECRET_VARIABLES: ReadonlySet<string> = new Set([
  // Claude login for the subscription; only Claude Code itself needs it.
  'CLAUDE_CODE_OAUTH_TOKEN',
  // Sessions use the subscription, never an API key.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
]);

/** Secrets Claude Code needs to log in; passed to it and nothing else. */
export const CLAUDE_CODE_SECRETS: readonly string[] = [
  'CLAUDE_CODE_OAUTH_TOKEN',
];

export function isSecretVariable(name: string): boolean {
  return name.startsWith(SECRET_PREFIX) || SECRET_VARIABLES.has(name);
}

/**
 * The environment for a child process: `base` without secrets (except the
 * ones named in `keep`), plus `extra`.
 */
export function childEnvironment(
  extra: Record<string, string> = {},
  {
    keep = [],
    base = process.env,
  }: { keep?: readonly string[]; base?: NodeJS.ProcessEnv } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (
      value !== undefined &&
      (!isSecretVariable(name) || keep.includes(name))
    ) {
      env[name] = value;
    }
  }
  return { ...env, ...extra };
}

/**
 * The API's own configuration (see `loadAppConfig`, `main.ts` and the
 * NixOS module). Session processes running as the API's user do not get
 * it: a session's `npm ci` would skip devDependencies under
 * `NODE_ENV=production`, its dev servers would take the API's `PORT`, and
 * a development API started in a session would open the production
 * database and act as the GitHub App.
 */
export const APP_CONFIG_VARIABLES: ReadonlySet<string> = new Set([
  'NODE_ENV',
  'PORT',
  'LISTEN_ADDRESS',
  'DATA_DIR',
  'DB_DIR',
  'FILES_DIR',
  'WORKSPACE_DIR',
  'MEMORY_DIR',
  'PROCESS_ISOLATION',
  'SESSION_USER',
  'SESSION_PATH',
  'SESSION_IDLE_TIMEOUT_MINUTES',
  'SESSION_STALL_MINUTES',
  'SESSION_INSTRUCTIONS_FILE',
  'SETUP_SCRIPT_TIMEOUT_MINUTES',
  'PR_POLL_INTERVAL_SECONDS',
  'AUTH_MODE',
  'CF_ACCESS_AUD',
  'CF_ACCESS_TEAM_DOMAIN',
  'CF_ACCESS_ALLOWED_EMAILS',
  'PREVIEW_ACCESS_AUD',
  'PREVIEW_URL',
  'PUBLIC_URL',
  'INTERNAL_API_URL',
  'ALLOWED_HOSTS',
  'ALLOWED_ORIGINS',
  'GITHUB_APP_ID',
  'NTFY_URL',
  'NTFY_TOPIC',
  'VAPID_PUBLIC_KEY',
  'VAPID_SUBJECT',
  'CLAUDE_CODE_EXECUTABLE',
  'API_GIT_CONFIG_GLOBAL',
  'LEGACY_CLAUDE_CONFIG_DIR',
  'CREDENTIALS_DIRECTORY',
  // Pointers to the app's secrets (the secrets themselves are filtered).
  'GITHUB_APP_PRIVATE_KEY_FILE',
  'GITHUB_WEBHOOK_SECRET_FILE',
  'NTFY_TOKEN_FILE',
  'VAPID_PRIVATE_KEY_FILE',
  // Set by the package's wrapper.
  'WEB_ROOT',
  'APP_VERSION',
  'APP_COMMIT',
  'APP_COMMIT_TIME',
]);

/** Whether a variable is the API's configuration (not for sessions). */
export function isAppConfigVariable(name: string): boolean {
  return APP_CONFIG_VARIABLES.has(name);
}
