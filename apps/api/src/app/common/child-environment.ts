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
