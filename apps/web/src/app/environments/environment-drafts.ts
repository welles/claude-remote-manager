import {
  ENVIRONMENT_FILE_NAME_PATTERN,
  MAX_ENVIRONMENT_ENTRIES,
  MAX_ENVIRONMENT_FILE_LENGTH,
  MAX_ENVIRONMENT_INSTRUCTIONS_LENGTH,
  MAX_ENVIRONMENT_NAME_LENGTH,
  MAX_ENVIRONMENT_SETUP_SCRIPT_LENGTH,
  MAX_ENVIRONMENT_VALUE_LENGTH,
  environmentVariableNameProblem,
  AGENT_ENGINES,
  type AgentEngineId,
  type EnvironmentDto,
  type SaveEnvironmentRequest,
  type SessionPermissionMode,
} from '@claude-remote-manager/shared-types';

let nextKey = 0;

/**
 * A variable or file being edited. A secret saved before has `stored`:
 * its value stays on the server (and is kept) unless the user replaces it.
 */
export interface EntryDraft {
  /** Stable key for the template. */
  key: number;
  id: string | null;
  /** Variable name (for files: the variable that gets the path). */
  name: string;
  secret: boolean;
  /** Value of a variable or content of a file; `''` while kept. */
  value: string;
  /** Only files. */
  fileName: string;
  /** A secret with a stored value on the server. */
  stored: boolean;
  /** Length of the stored value. */
  length: number;
  /** The user replaces the stored value (types a new one). */
  replacing: boolean;
}

/** A preset repository; `baseBranch: ''` uses the default branch. */
export interface RepositoryDraft {
  key: number;
  repositoryId: string;
  baseBranch: string;
}

/** An engine's presets; `''`: no preset. */
export interface EnginePresetsDraft {
  model: string;
  permissionMode: SessionPermissionMode | '';
}

export interface EnvironmentDraft {
  name: string;
  isDefault: boolean;
  instructions: string;
  setupScript: string;
  /** Engine the new-session form preselects; `''`: none. */
  presetEngine: AgentEngineId | '';
  /** Per engine (also one this server does not have: kept as it is). */
  presets: Record<AgentEngineId, EnginePresetsDraft>;
  repositories: RepositoryDraft[];
  variables: EntryDraft[];
  files: EntryDraft[];
}

export function newEntry(): EntryDraft {
  return {
    key: nextKey++,
    id: null,
    name: '',
    secret: true,
    value: '',
    fileName: '',
    stored: false,
    length: 0,
    replacing: false,
  };
}

export function newRepository(): RepositoryDraft {
  return { key: nextKey++, repositoryId: '', baseBranch: '' };
}

function presetsDraft(
  presets?: EnvironmentDto['presets'],
): Record<AgentEngineId, EnginePresetsDraft> {
  return Object.fromEntries(
    AGENT_ENGINES.map((engine) => [
      engine,
      {
        model: presets?.[engine]?.model ?? '',
        permissionMode: presets?.[engine]?.permissionMode ?? '',
      },
    ]),
  ) as Record<AgentEngineId, EnginePresetsDraft>;
}

export function emptyDraft(): EnvironmentDraft {
  return {
    name: '',
    isDefault: false,
    instructions: '',
    setupScript: '',
    presetEngine: '',
    presets: presetsDraft(),
    repositories: [],
    variables: [],
    files: [],
  };
}

/** The draft of a saved environment. */
export function draftOf(environment: EnvironmentDto): EnvironmentDraft {
  return {
    name: environment.name,
    isDefault: environment.isDefault,
    instructions: environment.instructions ?? '',
    setupScript: environment.setupScript ?? '',
    presetEngine: environment.presetEngine ?? '',
    presets: presetsDraft(environment.presets),
    repositories: environment.repositories.map((repository) => ({
      key: nextKey++,
      repositoryId: repository.repositoryId,
      baseBranch: repository.baseBranch ?? '',
    })),
    variables: environment.variables.map((variable) => ({
      ...newEntry(),
      id: variable.id,
      name: variable.name,
      secret: variable.secret,
      value: variable.value ?? '',
      stored: variable.secret,
      length: variable.length,
    })),
    files: environment.files.map((file) => ({
      ...newEntry(),
      id: file.id,
      name: file.variable,
      fileName: file.fileName,
      secret: file.secret,
      value: file.content ?? '',
      stored: file.secret,
      length: file.length,
    })),
  };
}

/** Whether the entry keeps the value stored on the server. */
export function keepsStored(entry: EntryDraft): boolean {
  return entry.stored && entry.secret && !entry.replacing;
}

/** Problems of a draft, by field (`variable-<key>`, `file-<key>`, …). */
export function draftProblems(draft: EnvironmentDraft): Map<string, string> {
  const problems = new Map<string, string>();
  const name = draft.name.trim();
  if (!name) {
    problems.set('name', 'Give the environment a name');
  } else if (name.length > MAX_ENVIRONMENT_NAME_LENGTH) {
    problems.set('name', `At most ${MAX_ENVIRONMENT_NAME_LENGTH} characters`);
  }
  if (draft.instructions.length > MAX_ENVIRONMENT_INSTRUCTIONS_LENGTH) {
    problems.set('instructions', 'Too long');
  }
  if (draft.setupScript.length > MAX_ENVIRONMENT_SETUP_SCRIPT_LENGTH) {
    problems.set('setupScript', 'Too long');
  }
  if (draft.variables.length + draft.files.length > MAX_ENVIRONMENT_ENTRIES) {
    problems.set(
      'entries',
      `At most ${MAX_ENVIRONMENT_ENTRIES} variables and files together`,
    );
  }
  const seen = new Set<string>();
  const check = (
    entry: EntryDraft,
    field: string,
    maxLength: number,
  ): string | null => {
    const entryName = entry.name.trim();
    const nameProblem = entryName
      ? environmentVariableNameProblem(entryName)
      : 'Enter a variable name';
    if (nameProblem) {
      return nameProblem;
    }
    if (seen.has(entryName)) {
      return `${entryName} is used twice`;
    }
    seen.add(entryName);
    if (
      field === 'file' &&
      !ENVIRONMENT_FILE_NAME_PATTERN.test(entry.fileName)
    ) {
      return 'File name: letters, digits, ., _ and - (no slashes)';
    }
    if (!keepsStored(entry)) {
      if (entry.secret && entry.value === '') {
        return field === 'file' ? 'Enter the content' : 'Enter a value';
      }
      if (entry.stored && !entry.secret && entry.value === '') {
        // A secret turned plain: its stored value is never revealed.
        return field === 'file'
          ? 'Enter the content again'
          : 'Enter the value again';
      }
      if (entry.value.length > maxLength) {
        return `At most ${maxLength} characters`;
      }
    }
    return null;
  };
  for (const entry of draft.variables) {
    const problem = check(entry, 'variable', MAX_ENVIRONMENT_VALUE_LENGTH);
    if (problem) {
      problems.set(`variable-${entry.key}`, problem);
    }
  }
  for (const entry of draft.files) {
    const problem = check(entry, 'file', MAX_ENVIRONMENT_FILE_LENGTH);
    if (problem) {
      problems.set(`file-${entry.key}`, problem);
    }
  }
  return problems;
}

/** The request that saves a draft. */
export function saveRequest(draft: EnvironmentDraft): SaveEnvironmentRequest {
  const text = (value: string) => (value.trim() ? value : null);
  return {
    name: draft.name.trim(),
    isDefault: draft.isDefault,
    instructions: text(draft.instructions),
    setupScript: text(draft.setupScript),
    presetEngine: draft.presetEngine || null,
    presets: Object.fromEntries(
      AGENT_ENGINES.map((engine) => [
        engine,
        {
          model: draft.presets[engine].model || null,
          permissionMode: draft.presets[engine].permissionMode || null,
        },
      ]),
    ),
    repositories: draft.repositories
      .filter((repository) => repository.repositoryId)
      .map((repository) => ({
        repositoryId: repository.repositoryId,
        ...(repository.baseBranch ? { baseBranch: repository.baseBranch } : {}),
      })),
    variables: draft.variables.map((entry) => ({
      ...(entry.id ? { id: entry.id } : {}),
      name: entry.name.trim(),
      secret: entry.secret,
      ...(keepsStored(entry) ? {} : { value: entry.value }),
    })),
    files: draft.files.map((entry) => ({
      ...(entry.id ? { id: entry.id } : {}),
      variable: entry.name.trim(),
      fileName: entry.fileName,
      secret: entry.secret,
      ...(keepsStored(entry) ? {} : { content: entry.value }),
    })),
  };
}
