import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  childEnvironment,
  CLAUDE_CODE_SECRETS,
  isAppConfigVariable,
} from './child-environment';

/**
 * Who runs what. Two modes, chosen explicitly (`PROCESS_ISOLATION`):
 *
 * - `single-user` (the NixOS module, local development): the API and
 *   everything a session runs share the OS user, so sessions can do what
 *   that user can do in a terminal. Child processes inherit the API's
 *   environment without the app's secrets; `SESSION_PATH` replaces the
 *   PATH of session processes (the user's profiles).
 * - `separate-users` (the container image): the API runs as its own user
 *   and starts everything a session runs (Claude Code, setup scripts, git
 *   commands in session clones) as the session user, through `setpriv`
 *   with all capabilities dropped and `no_new_privs`, and with an
 *   environment built from an allowlist. The session user cannot read the
 *   API's files (database, GitHub App key) or its process environment.
 *
 * In `separate-users` mode the API process needs these capabilities (the
 * image entrypoint or the NixOS module's systemd unit give them as ambient
 * capabilities while dropping root):
 * SETUID/SETGID (start processes as the session user), KILL (signal them),
 * CHOWN (hand session clones and directories to the session user) and
 * DAC_OVERRIDE (read transcripts, remove session directories). Its own
 * child processes (git on mirrors) get none of them.
 */
export type ProcessIsolation =
  | {
      mode: 'single-user';
      /** PATH of session processes (`SESSION_PATH`); without it the API's. */
      sessionPath?: string;
    }
  | {
      mode: 'separate-users';
      sessionUser: SessionUser;
      /**
       * PATH of session processes (`SESSION_PATH`); without it they get the
       * API's PATH. Lets sessions have directories on their PATH that the
       * session user can write (its Nix profile), which the API's own PATH
       * must never contain: the API runs commands from it.
       */
      sessionPath?: string;
    };

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
  // glibc's locale data on NixOS
  'LOCALE_ARCHIVE',
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

/**
 * Absolute path of `name` in the directories of `path` (by default the
 * API's own PATH), or `null`. Commands the API starts with capabilities
 * must be resolved here: a bare name would be looked up in the PATH of the
 * child's environment, which for session processes may hold directories
 * the session user can write.
 */
export function findExecutable(
  name: string,
  path: string = process.env['PATH'] ?? '',
): string | null {
  for (const dir of path.split(':')) {
    if (!dir || !isAbsolute(dir)) {
      continue;
    }
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // not here
    }
  }
  return null;
}

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
  setpriv = findExecutable('setpriv'),
): void {
  if (isolation.mode !== 'separate-users') {
    return;
  }
  if (uid === 0) {
    throw new Error(
      'PROCESS_ISOLATION=separate-users: the API must not run as root; start it through the image entrypoint or the NixOS module',
    );
  }
  if (setpriv === null) {
    throw new Error(
      "PROCESS_ISOLATION=separate-users: setpriv (util-linux) is not on the API's PATH",
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
      `PROCESS_ISOLATION=separate-users: the API lacks ${missing.join(', ')}; start it through the image entrypoint (and do not drop these capabilities from the container) or the NixOS module`,
    );
  }
}

/**
 * Starts processes as the API or as the session user, see
 * {@link ProcessIsolation}.
 */
export class ProcessLauncher {
  /**
   * `setpriv`, resolved once in the API's own PATH, so that the session
   * environment's PATH never decides which program gets the API's
   * capabilities.
   */
  readonly setpriv: string;

  /**
   * @param apiEnv variables only the API's own processes get, e.g.
   * `GIT_CONFIG_GLOBAL` for its git commands on mirrors.
   */
  constructor(
    readonly isolation: ProcessIsolation,
    private readonly apiEnv: Record<string, string> = {},
  ) {
    this.setpriv = findExecutable('setpriv') ?? 'setpriv';
  }

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
      return { command: this.setpriv, args: [...drop, '--', command, ...args] };
    }
    const { uid, gid } = this.isolation.sessionUser;
    return {
      command: this.setpriv,
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
   * Environment of a process: for the API's own processes the API's
   * environment without secrets, plus the API-only variables; for session
   * processes in `single-user` mode the API's environment without secrets
   * and without the API's own configuration (`isAppConfigVariable`), with
   * `SESSION_PATH` as `PATH`, in `separate-users` mode only the allowlisted
   * variables and the session user's identity. `keep` names secrets to
   * pass anyway (Claude Code's login), `extra` is added last.
   */
  environment(
    role: ProcessRole,
    extra: Record<string, string> = {},
    {
      keep = [],
      base = process.env,
    }: { keep?: readonly string[]; base?: NodeJS.ProcessEnv } = {},
  ): Record<string, string> {
    if (role === 'api') {
      return childEnvironment({ ...this.apiEnv, ...extra }, { keep, base });
    }
    if (this.isolation.mode === 'single-user') {
      const own = Object.fromEntries(
        Object.entries(base).filter(([name]) => !isAppConfigVariable(name)),
      );
      return childEnvironment(
        {
          ...(this.isolation.sessionPath
            ? { PATH: this.isolation.sessionPath }
            : {}),
          ...extra,
        },
        { keep, base: own },
      );
    }
    const user = this.isolation.sessionUser;
    const env: Record<string, string> = {};
    for (const name of [...SESSION_ENV_ALLOWLIST, ...keep]) {
      const value = base[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
    if (this.isolation.sessionPath) {
      env['PATH'] = this.isolation.sessionPath;
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

/** Nest token of the {@link ProcessLauncher}. */
export const PROCESS_LAUNCHER = Symbol('PROCESS_LAUNCHER');
