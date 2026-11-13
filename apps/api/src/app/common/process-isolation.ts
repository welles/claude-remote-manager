import { readFileSync } from 'node:fs';
import { childEnvironment, CLAUDE_CODE_SECRETS } from './child-environment';

/**
 * Who runs what. Two modes, chosen explicitly (`PROCESS_ISOLATION`):
 *
 * - `single-user` (local development): the API and everything a session
 *   runs share the OS user. Child processes inherit the API's environment
 *   without the app's secrets.
 * - `separate-users` (the container image): the API runs as its own user
 *   and starts everything a session runs (Claude Code, setup scripts, git
 *   commands in session clones) as the session user, through `setpriv`
 *   with all capabilities dropped and `no_new_privs`, and with an
 *   environment built from an allowlist. The session user cannot read the
 *   API's files (database, GitHub App key) or its process environment.
 *
 * In `separate-users` mode the API process needs these capabilities (the
 * entrypoint gives them as ambient capabilities while dropping root):
 * SETUID/SETGID (start processes as the session user), KILL (signal them),
 * CHOWN (hand session clones and directories to the session user) and
 * DAC_OVERRIDE (read transcripts, remove session directories). Its own
 * child processes (git on mirrors) get none of them.
 */
export type ProcessIsolation =
  | { mode: 'single-user' }
  | { mode: 'separate-users'; sessionUser: SessionUser };

export interface SessionUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

export const ISOLATION_MODES = ['single-user', 'separate-users'] as const;

/** Who a process runs as: the API itself or the session user. */
export type ProcessRole = 'api' | 'session';

/**
 * Variables a session process gets from the API's environment in
 * `separate-users` mode; everything else is left out. HOME, USER and
 * LOGNAME are the session user's.
 */
export const SESSION_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'SHELL',
  'TMPDIR',
  'CLAUDE_CONFIG_DIR',
  'DISABLE_AUTOUPDATER',
  'NIX_SSL_CERT_FILE',
  'NIX_CONF_DIR',
  'SSL_CERT_FILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/** Capabilities the API needs in `separate-users` mode (bit numbers). */
export const REQUIRED_CAPABILITIES: Record<string, number> = {
  CAP_CHOWN: 0,
  CAP_DAC_OVERRIDE: 1,
  CAP_KILL: 5,
  CAP_SETGID: 6,
  CAP_SETUID: 7,
};

/** The session user from `/etc/passwd`. */
export function lookupUser(
  name: string,
  passwd: string = readFileSync('/etc/passwd', 'utf8'),
): SessionUser {
  for (const line of passwd.split('\n')) {
    const [user, , uid, gid, , home] = line.split(':');
    if (user === name) {
      return { name, uid: Number(uid), gid: Number(gid), home };
    }
  }
  throw new Error(`The session user ${name} does not exist`);
}

/** Effective capabilities of this process (`CapEff` in /proc/self/status). */
export function effectiveCapabilities(
  status: string = readFileSync('/proc/self/status', 'utf8'),
): bigint {
  const match = /^CapEff:\s*([0-9a-f]+)$/m.exec(status);
  return match ? BigInt(`0x${match[1]}`) : 0n;
}

/**
 * Checks that this process can run session processes as another user:
 * not root, with the required capabilities, as a different user than the
 * session user. Throws with an explanation otherwise.
 */
export function checkSeparateUsers(
  isolation: ProcessIsolation,
  uid = process.getuid?.() ?? -1,
  capabilities = effectiveCapabilities(),
): void {
  if (isolation.mode !== 'separate-users') {
    return;
  }
  if (uid === 0) {
    throw new Error(
      'PROCESS_ISOLATION=separate-users: the API must not run as root; start it through the image entrypoint',
    );
  }
  if (uid === isolation.sessionUser.uid) {
    throw new Error(
      'PROCESS_ISOLATION=separate-users: the API runs as the session user',
    );
  }
  const missing = Object.entries(REQUIRED_CAPABILITIES)
    .filter(([, bit]) => (capabilities & (1n << BigInt(bit))) === 0n)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `PROCESS_ISOLATION=separate-users: the API lacks ${missing.join(', ')}; start it through the image entrypoint (and do not drop these capabilities from the container)`,
    );
  }
}

/**
 * Starts processes as the API or as the session user, see
 * {@link ProcessIsolation}.
 */
export class ProcessLauncher {
  constructor(readonly isolation: ProcessIsolation) {}

  get separated(): boolean {
    return this.isolation.mode === 'separate-users';
  }

  /** The session user, in `separate-users` mode. */
  get sessionUser(): SessionUser | null {
    return this.isolation.mode === 'separate-users'
      ? this.isolation.sessionUser
      : null;
  }

  /**
   * Command line that runs `command` as `role`. Session processes go
   * through `setpriv` to the session user; the API's own processes through
   * `setpriv` as well, only to drop the API's capabilities.
   */
  command(
    role: ProcessRole,
    command: string,
    args: readonly string[],
  ): { command: string; args: string[] } {
    if (this.isolation.mode === 'single-user') {
      return { command, args: [...args] };
    }
    const drop = ['--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs'];
    if (role === 'api') {
      return { command: 'setpriv', args: [...drop, '--', command, ...args] };
    }
    const { uid, gid } = this.isolation.sessionUser;
    return {
      command: 'setpriv',
      args: [
        `--reuid=${uid}`,
        `--regid=${gid}`,
        '--init-groups',
        ...drop,
        '--',
        command,
        ...args,
      ],
    };
  }

  /**
   * Environment of a process: for the API's own processes and in
   * `single-user` mode the API's environment without secrets; for session
   * processes in `separate-users` mode only the allowlisted variables and
   * the session user's identity. `keep` names secrets to pass anyway
   * (Claude Code's login), `extra` is added last.
   */
  environment(
    role: ProcessRole,
    extra: Record<string, string> = {},
    {
      keep = [],
      base = process.env,
    }: { keep?: readonly string[]; base?: NodeJS.ProcessEnv } = {},
  ): Record<string, string> {
    if (this.isolation.mode === 'single-user' || role === 'api') {
      return childEnvironment(extra, { keep, base });
    }
    const user = this.isolation.sessionUser;
    const env: Record<string, string> = {};
    for (const name of [...SESSION_ENV_ALLOWLIST, ...keep]) {
      const value = base[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
    return {
      ...env,
      HOME: user.home,
      USER: user.name,
      LOGNAME: user.name,
      ...extra,
    };
  }
}

/** Single-user launcher, the default outside the container (and in tests). */
export const SINGLE_USER = new ProcessLauncher({ mode: 'single-user' });

/** Secrets Claude Code itself may get in either mode. */
export const SESSION_SECRETS = CLAUDE_CODE_SECRETS;
