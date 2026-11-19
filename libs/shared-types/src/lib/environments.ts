import type {
  SessionPermissionMode,
  SessionRepositoryRequest,
} from './session';

/**
 * Environments bundle what sessions need for a kind of work: variables and
 * files (secrets of any kind, or plain values), instructions appended to
 * the system prompt, a setup script and presets for the new-session form.
 * Chosen when a session is created; read afresh at every process start.
 */

/** Pattern of variable names, as in a shell. */
export const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names an environment may not set: the session's own (PATH, HOME, …),
 * Claude Code's and the app's. See `reservedVariableReason`.
 */
export const RESERVED_ENVIRONMENT_VARIABLES: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
];

/** Prefixes of names an environment may not set. */
export const RESERVED_ENVIRONMENT_PREFIXES: readonly string[] = [
  'CLAUDE_',
  'ANTHROPIC_',
  'CRM_',
  'GIT_CONFIG_',
];

/**
 * Why a variable name cannot be used in an environment, or `null` if it
 * can: not a shell name, or one the session, Claude Code or the app needs.
 */
export function environmentVariableNameProblem(name: string): string | null {
  if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
    return 'Use letters, digits and _, not starting with a digit';
  }
  if (RESERVED_ENVIRONMENT_VARIABLES.includes(name)) {
    return `${name} is set by the session itself`;
  }
  const prefix = RESERVED_ENVIRONMENT_PREFIXES.find((entry) =>
    name.startsWith(entry),
  );
  return prefix
    ? `Names starting with ${prefix} are reserved for Claude Code and the app`
    : null;
}

/** Secret values shorter than this are not masked in the conversation. */
export const MIN_MASKED_SECRET_LENGTH = 6;

export const MAX_ENVIRONMENT_NAME_LENGTH = 80;
export const MAX_ENVIRONMENT_ENTRIES = 100;
/** Value of a variable. */
export const MAX_ENVIRONMENT_VALUE_LENGTH = 32 * 1024;
/** Content of a file. */
export const MAX_ENVIRONMENT_FILE_LENGTH = 256 * 1024;
export const MAX_ENVIRONMENT_INSTRUCTIONS_LENGTH = 20_000;
export const MAX_ENVIRONMENT_SETUP_SCRIPT_LENGTH = 20_000;
/** File names of environment files: one path segment. */
export const ENVIRONMENT_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * A variable of an environment. A secret's value never leaves the server:
 * `value` is `null`, `length` tells how long it is.
 */
export interface EnvironmentVariableDto {
  id: string;
  name: string;
  secret: boolean;
  /** `null` for secrets. */
  value: string | null;
  /** Length of the value (also of a secret's). */
  length: number;
}

/**
 * A file of an environment: written for each process of a session into a
 * directory of its own, with its path in the variable `variable`.
 */
export interface EnvironmentFileDto {
  id: string;
  /** Variable that gets the file's path, e.g. `GOOGLE_APPLICATION_CREDENTIALS`. */
  variable: string;
  /** Name of the file, e.g. `credentials.json`. */
  fileName: string;
  secret: boolean;
  /** `null` for secrets. */
  content: string | null;
  /** Length of the content in characters (also of a secret's). */
  length: number;
}

/** A session that uses an environment. */
export interface EnvironmentSessionDto {
  id: string;
  title: string | null;
  archived: boolean;
}

export interface EnvironmentDto {
  id: string;
  name: string;
  /** Appended to the system prompt of the environment's sessions. */
  instructions: string | null;
  /** Run once when a session is prepared, after the repositories' scripts. */
  setupScript: string | null;
  /** Presets of the new-session form. */
  model: string | null;
  permissionMode: SessionPermissionMode | null;
  /** In order; the first is the main repository. */
  repositories: SessionRepositoryRequest[];
  /** Chosen in the new-session form unless the user picks another. */
  isDefault: boolean;
  variables: EnvironmentVariableDto[];
  files: EnvironmentFileDto[];
  /** Sessions that use the environment (archived ones too). */
  sessions: EnvironmentSessionDto[];
  createdAt: string;
  updatedAt: string;
}

/** Response of `GET /api/environments`, by name. */
export interface EnvironmentListResponse {
  environments: EnvironmentDto[];
}

/**
 * A variable to save. `id` names an existing entry; a secret with `id` and
 * without `value` keeps its stored value (also when renamed).
 */
export interface SaveEnvironmentVariable {
  id?: string;
  name: string;
  secret: boolean;
  value?: string;
}

/** A file to save; like {@link SaveEnvironmentVariable} with `content`. */
export interface SaveEnvironmentFile {
  id?: string;
  variable: string;
  fileName: string;
  secret: boolean;
  content?: string;
}

/**
 * Body of `POST /api/environments` and `PUT /api/environments/:id`: the
 * whole environment; entries left out are deleted.
 */
export interface SaveEnvironmentRequest {
  name: string;
  instructions?: string | null;
  setupScript?: string | null;
  model?: string | null;
  permissionMode?: SessionPermissionMode | null;
  repositories?: SessionRepositoryRequest[];
  isDefault?: boolean;
  variables?: SaveEnvironmentVariable[];
  files?: SaveEnvironmentFile[];
}

/** The environment of a session, as the session shows it. */
export interface SessionEnvironmentDto {
  id: string;
  name: string;
}
