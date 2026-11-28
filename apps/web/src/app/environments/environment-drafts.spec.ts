import type { EnvironmentDto } from '@claude-remote-manager/shared-types';
import {
  draftOf,
  draftProblems,
  emptyDraft,
  newEntry,
  saveRequest,
} from './environment-drafts';
import { enginePresets } from './testing/environments';

const saved: EnvironmentDto = {
  id: 'e1',
  name: 'Staging',
  instructions: 'Use the staging API',
  setupScript: null,
  presetEngine: null,
  presets: enginePresets({ model: 'haiku' }),
  repositories: [{ repositoryId: 'r1', baseBranch: 'dev' }],
  isDefault: true,
  variables: [
    { id: 'v1', name: 'API_KEY', secret: true, value: null, length: 32 },
    { id: 'v2', name: 'API_URL', secret: false, value: 'https://x', length: 9 },
  ],
  files: [
    {
      id: 'f1',
      variable: 'GOOGLE_APPLICATION_CREDENTIALS',
      fileName: 'sa.json',
      secret: true,
      content: null,
      length: 2000,
    },
  ],
  sessions: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('environment drafts', () => {
  it('keeps stored secrets unless they are replaced', () => {
    const draft = draftOf(saved);
    expect(draftProblems(draft).size).toBe(0);
    expect(saveRequest(draft)).toEqual({
      name: 'Staging',
      isDefault: true,
      instructions: 'Use the staging API',
      setupScript: null,
      presetEngine: null,
      presets: {
        'claude-code': { model: 'haiku', permissionMode: null },
        codex: { model: null, permissionMode: null },
      },
      repositories: [{ repositoryId: 'r1', baseBranch: 'dev' }],
      variables: [
        { id: 'v1', name: 'API_KEY', secret: true },
        { id: 'v2', name: 'API_URL', secret: false, value: 'https://x' },
      ],
      files: [
        {
          id: 'f1',
          variable: 'GOOGLE_APPLICATION_CREDENTIALS',
          fileName: 'sa.json',
          secret: true,
        },
      ],
    });
    // Replacing needs a new value.
    draft.variables[0] = { ...draft.variables[0], replacing: true };
    expect(draftProblems(draft).get(`variable-${draft.variables[0].key}`)).toBe(
      'Enter a value',
    );
    draft.variables[0].value = 'new-secret';
    expect(saveRequest(draft).variables?.[0]).toEqual({
      id: 'v1',
      name: 'API_KEY',
      secret: true,
      value: 'new-secret',
    });
  });

  it('asks for the value again when a stored secret is turned plain', () => {
    const draft = draftOf(saved);
    // What the editor's switch does for a stored secret.
    draft.variables[0] = {
      ...draft.variables[0],
      secret: false,
      replacing: true,
      value: '',
    };
    draft.files[0] = {
      ...draft.files[0],
      secret: false,
      replacing: true,
      value: '',
    };
    const problems = draftProblems(draft);
    expect(problems.get(`variable-${draft.variables[0].key}`)).toBe(
      'Enter the value again',
    );
    expect(problems.get(`file-${draft.files[0].key}`)).toBe(
      'Enter the content again',
    );
    draft.variables[0].value = 'now plain';
    expect(draftProblems(draft).has(`variable-${draft.variables[0].key}`)).toBe(
      false,
    );
  });

  it('checks names, duplicates, file names and the environment name', () => {
    const draft = emptyDraft();
    const reserved = { ...newEntry(), name: 'PATH', value: 'x' };
    const prefixed = { ...newEntry(), name: 'CLAUDE_X', value: 'x' };
    const first = { ...newEntry(), name: 'TOKEN', value: 'secret' };
    const twice = { ...newEntry(), name: 'TOKEN', value: 'secret' };
    const file = {
      ...newEntry(),
      name: 'KUBECONFIG',
      fileName: '../config',
      value: 'x',
    };
    draft.variables = [reserved, prefixed, first, twice];
    draft.files = [file];
    const problems = draftProblems(draft);
    expect(problems.get('name')).toBe('Give the environment a name');
    expect(problems.get(`variable-${reserved.key}`)).toContain(
      'set by the session',
    );
    expect(problems.get(`variable-${prefixed.key}`)).toContain('CLAUDE_');
    expect(problems.has(`variable-${first.key}`)).toBe(false);
    expect(problems.get(`variable-${twice.key}`)).toBe('TOKEN is used twice');
    expect(problems.get(`file-${file.key}`)).toContain('File name');
  });

  it('allows empty plain values but not empty new secrets', () => {
    const draft = emptyDraft();
    draft.name = 'Plain';
    const plain = { ...newEntry(), name: 'EMPTY', secret: false };
    const secret = { ...newEntry(), name: 'KEY' };
    draft.variables = [plain, secret];
    const problems = draftProblems(draft);
    expect(problems.has(`variable-${plain.key}`)).toBe(false);
    expect(problems.get(`variable-${secret.key}`)).toBe('Enter a value');
  });
});
