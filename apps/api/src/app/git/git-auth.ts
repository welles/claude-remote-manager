/** Name and email for commits. */
export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Credentials for one git command of the API (clone, fetch, push), given to
 * git through the environment: never in arguments (visible to every
 * process), never in a config file or remote URL (they would outlive the
 * command).
 */
export interface GitAuth {
  env: Record<string, string>;
}

/**
 * Auth with a GitHub installation token: an `Authorization` header for
 * requests to github.com, set through `GIT_CONFIG_*` variables, and no
 * credential helpers (neither the user's nor the session clone's own).
 */
export function githubTokenAuth(token: string): GitAuth {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    env: {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '',
    },
  };
}

/** Variables that make git commit as `identity` (author and committer). */
export function identityEnvironment(
  identity: GitIdentity,
): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}
