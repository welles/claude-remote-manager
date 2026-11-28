import { provideHttpClient } from '@angular/common/http';
import { accountDto, mainAccountList } from '../accounts/testing/accounts';
import { AccountsStore } from '../accounts/accounts-store';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  AccountDto,
  AgentEngineId,
  EnvironmentDto,
  RepositoryDto,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { flushEngines } from '../engines/testing/engines';
import { NewSessionForm, type RepositoryChoice } from './new-session-form';
import { sessionDto } from './testing/session-dto';
import { EditorDriver } from '../testing/editor';

const repository = (
  id: string,
  fullName: string,
  defaultBranch = 'main',
): RepositoryDto => {
  const [owner, name] = fullName.split('/');
  return {
    id,
    owner,
    name,
    fullName,
    cloneUrl: `https://github.com/${fullName}.git`,
    local: false,
    github: null,
    defaultBranch,
    localPath: `/repos/${fullName}`,
    setupScript: null,
    clonedAt: '2026-01-01T00:00:00.000Z',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    lastError: null,
    activity: null,
    clones: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
};

/** The protected API of the form, for driving it in tests. */
interface FormInternals {
  prompt: string;
  model: string;
  accountId: string;
  permissionMode: string;
  projectName: string;
  mode(): 'repository' | 'project' | 'scratch';
  choices(): RepositoryChoice[];
  setMode(mode: 'repository' | 'project' | 'scratch'): void;
  addRepository(): void;
  removeRepository(index: number): void;
  chooseRepository(index: number, id: string): void;
  chooseBaseBranch(index: number, branch: string): void;
  canStart(): boolean;
  create(): void;
  addFromGitHub(repository: RepositoryDto): void;
  images: AttachmentDrafts;
  environmentId(): string;
  chooseEnvironment(id: string): void;
  touched: boolean;
  engine(): AgentEngineId;
  pickEngine(engine: AgentEngineId): void;
  modeOptions(): { value: string }[];
  modelOptions(): { value: string; label: string }[];
}

import type { AttachmentDrafts } from '../attachments/attachment-drafts';

describe('NewSessionForm', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NewSessionForm],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const render = async (
    repositories: RepositoryDto[],
    environments: EnvironmentDto[] = [],
    {
      engines = ['claude-code'],
      accounts = mainAccountList().accounts,
    }: { engines?: AgentEngineId[]; accounts?: AccountDto[] } = {},
  ) => {
    const fixture = TestBed.createComponent(NewSessionForm);
    const created: SessionDto[] = [];
    fixture.componentInstance.created.subscribe((session) =>
      created.push(session),
    );
    fixture.detectChanges();
    flushEngines(http, ...engines);
    http.expectOne('/api/accounts').flush({ accounts });
    http.expectOne('/api/models').flush({
      models: [
        {
          value: null,
          label: 'Default (recommended)',
          description: '',
          resolvedModel: 'claude-x',
        },
        {
          value: 'haiku',
          label: 'Haiku 5',
          description: 'Fast',
          resolvedModel: 'claude-haiku-5',
        },
      ],
      source: 'claude-code',
      updatedAt: null,
    });
    http
      .expectOne('/api/repositories')
      .flush({ repositories, strayDirectories: [] });
    http.expectOne('/api/environments').flush({ environments });
    await fixture.whenStable();
    const form = fixture.componentInstance as unknown as FormInternals;
    const element = fixture.nativeElement as HTMLElement;
    return { fixture, form, element, created };
  };

  it('uses repositories chosen from GitHub as main or additional repository', async () => {
    const { form } = await render([repository('r1', 'acme/app')]);
    form.addFromGitHub(repository('g1', 'alice/tool'));
    http
      .expectOne('/api/repositories/g1/branches')
      .flush({ defaultBranch: null, branches: [] });
    expect(form.choices()).toEqual([{ repositoryId: 'g1', baseBranch: '' }]);
    form.addFromGitHub(repository('g2', 'acme/lib'));
    http
      .expectOne('/api/repositories/g2/branches')
      .flush({ defaultBranch: null, branches: [] });
    // Choosing one again changes nothing.
    form.addFromGitHub(repository('g1', 'alice/tool'));
    expect(form.choices().map((choice) => choice.repositoryId)).toEqual([
      'g1',
      'g2',
    ]);
  });

  it('starts a session on a main repository plus another with a base branch', async () => {
    const { fixture, form, element, created } = await render([
      repository('r1', 'acme/app'),
      repository('r2', 'acme/lib', 'trunk'),
    ]);
    expect(form.mode()).toBe('repository');
    // New sessions start in auto mode.
    expect(form.permissionMode).toBe('auto');
    expect(element.textContent).toContain('Main repository');
    form.prompt = ' Add the export ';
    expect(form.canStart()).toBe(false);

    form.chooseRepository(0, 'r1');
    http
      .expectOne('/api/repositories/r1/branches')
      .flush({ defaultBranch: 'main', branches: ['main'] });
    form.addRepository();
    form.chooseRepository(1, 'r2');
    http
      .expectOne('/api/repositories/r2/branches')
      .flush({ defaultBranch: 'trunk', branches: ['release', 'trunk'] });
    form.chooseBaseBranch(1, 'release');
    form.model = 'haiku';
    form.permissionMode = 'plan';
    fixture.detectChanges();
    await fixture.whenStable();
    expect(element.textContent).toContain('Additional repository');
    // What the chosen mode means.
    expect(element.textContent).toContain('presents the plan for approval');
    expect(form.canStart()).toBe(true);

    form.create();
    const request = http.expectOne({ method: 'POST', url: '/api/sessions' });
    expect(request.request.body).toEqual({
      prompt: 'Add the export',
      model: 'haiku',
      permissionMode: 'plan',
      repositories: [
        { repositoryId: 'r1' },
        { repositoryId: 'r2', baseBranch: 'release' },
      ],
    });
    request.flush(sessionDto({ id: 'new', status: 'preparing' }));
    expect(created.map((session) => session.id)).toEqual(['new']);
    expect(form.prompt).toBe('');
  });

  it('starts a new project, optionally with repositories', async () => {
    const { form } = await render([repository('r1', 'acme/lib')]);
    form.prompt = 'Build a tool';
    form.setMode('project');
    expect(form.choices()).toEqual([]);
    form.projectName = '../bad';
    expect(form.canStart()).toBe(false);
    form.projectName = 'new-tool';
    expect(form.canStart()).toBe(true);
    form.addRepository();
    form.chooseRepository(0, 'r1');
    http
      .expectOne('/api/repositories/r1/branches')
      .flush({ defaultBranch: 'main', branches: ['main'] });

    form.create();
    expect(
      http.expectOne({ method: 'POST', url: '/api/sessions' }).request.body,
    ).toEqual({
      prompt: 'Build a tool',
      permissionMode: 'auto',
      repositories: [{ repositoryId: 'r1' }],
      newProject: { name: 'new-tool' },
    });

    // Back to a repository: the chosen one becomes the main repository.
    form.setMode('repository');
    expect(form.choices()).toEqual([{ repositoryId: 'r1', baseBranch: '' }]);
    form.removeRepository(0);
    expect(form.choices()).toEqual([]);
  });

  it('offers a new project when no repository is registered', async () => {
    const { form, element, fixture } = await render([]);
    fixture.detectChanges();
    expect(form.mode()).toBe('project');
    expect(element.textContent).toContain('No repositories registered yet');
  });

  it('shows why a session could not be started', async () => {
    const { fixture, form, element } = await render([
      repository('r1', 'acme/app'),
    ]);
    form.prompt = 'x';
    form.chooseRepository(0, 'r1');
    http
      .expectOne('/api/repositories/r1/branches')
      .flush({ defaultBranch: 'main', branches: ['main'] });
    form.create();
    http
      .expectOne({ method: 'POST', url: '/api/sessions' })
      .flush(
        { message: 'model is not a valid model name' },
        { status: 400, statusText: 'Bad Request' },
      );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(
      element.querySelector('[data-testid="create-error"]')?.textContent,
    ).toContain('model is not a valid model name');
  });

  it('sends an explicitly chosen default mode', async () => {
    const { form } = await render([]);
    form.prompt = 'Ask first';
    form.setMode('scratch');
    form.permissionMode = 'default';
    form.create();
    expect(
      http.expectOne({ method: 'POST', url: '/api/sessions' }).request.body,
    ).toEqual({
      prompt: 'Ask first',
      permissionMode: 'default',
      scratch: true,
    });
  });

  it('offers the accounts when there are several and sends the chosen one', async () => {
    const { form, fixture, element } = await render([]);
    expect(element.querySelector('[data-testid="account"]')).toBeNull();
    TestBed.inject(AccountsStore).accounts.set([
      accountDto(),
      accountDto({ id: 'a1', name: 'Work', isDefault: false, position: 1 }),
    ]);
    fixture.detectChanges();
    expect(element.querySelector('[data-testid="account"]')).not.toBeNull();
    form.prompt = 'Hi';
    form.setMode('scratch');
    form.accountId = 'a1';
    form.create();
    expect(
      http.expectOne({ method: 'POST', url: '/api/sessions' }).request.body,
    ).toMatchObject({ accountId: 'a1' });
  });

  it('starts a scratch session without repository', async () => {
    const { form } = await render([repository('r1', 'acme/app')]);
    form.prompt = 'Quick question';
    form.setMode('scratch');
    expect(form.choices()).toEqual([]);
    expect(form.canStart()).toBe(true);

    form.create();
    expect(
      http.expectOne({ method: 'POST', url: '/api/sessions' }).request.body,
    ).toEqual({
      prompt: 'Quick question',
      permissionMode: 'auto',
      scratch: true,
    });
  });

  it('marks local projects in the repository list', async () => {
    const { form, fixture } = await render([
      { ...repository('p1', 'local/tool'), cloneUrl: null, local: true },
    ]);
    form.chooseRepository(0, 'p1');
    http
      .expectOne('/api/repositories/p1/branches')
      .flush({ defaultBranch: 'main', branches: [] });
    fixture.detectChanges();
    await fixture.whenStable();
    const select = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="repository-select"]',
    );
    expect(select?.textContent).toContain('local/tool (local project)');
  });

  it('starts a session with images for the first message', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    const { form } = await render([]);
    form.setMode('scratch');
    expect(form.canStart()).toBe(false);
    form.images.add([
      new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' }),
    ]);
    // Not before the upload is done.
    expect(form.canStart()).toBe(false);
    http
      .expectOne('/api/attachments')
      .flush({ id: 'a1', name: 'shot.png', mediaType: 'image/png', size: 1 });
    expect(form.canStart()).toBe(true);
    form.create();
    expect(
      http.expectOne({ method: 'POST', url: '/api/sessions' }).request.body,
    ).toEqual({
      prompt: '',
      attachmentIds: ['a1'],
      permissionMode: 'auto',
      scratch: true,
    });
  });
  it('completes # references from the chosen GitHub repositories and sends them', async () => {
    const { fixture, form, element } = await render([
      {
        ...repository('r1', 'acme/app'),
        github: { repositoryId: 1, installationId: 2, htmlUrl: '' },
      },
      repository('r2', 'acme/plain'),
    ]);
    form.chooseRepository(0, 'r1');
    http
      .expectOne('/api/repositories/r1/branches')
      .flush({ defaultBranch: 'main', branches: [] });
    await fixture.whenStable();
    new EditorDriver(element, 'new-prompt').type('Fix #1');
    await new Promise((resolve) => setTimeout(resolve, 200));
    http
      .expectOne(
        (request) =>
          request.url === '/api/github/references' &&
          request.params.get('repositories') === 'acme/app' &&
          request.params.get('query') === '1',
      )
      .flush({
        results: [
          {
            repository: 'acme/app',
            number: 17,
            kind: 'issue',
            title: 'Crash',
            state: 'open',
            draft: false,
            url: 'https://github.com/acme/app/issues/17',
            author: null,
            updatedAt: null,
          },
        ],
        errors: [],
      });
    await fixture.whenStable();
    (
      element.querySelector(
        '[data-testid="reference-suggestion"]',
      ) as HTMLElement
    ).dispatchEvent(new MouseEvent('mousedown'));
    await fixture.whenStable();
    expect(form.prompt).toBe('Fix #17 ');
    form.create();
    const request = http.expectOne('/api/sessions');
    expect(request.request.body).toMatchObject({
      prompt: 'Fix #17',
      references: [{ token: '#17', repository: 'acme/app', number: 17 }],
    });
    request.flush(sessionDto());
    // The chip asked GitHub about #17 meanwhile (or does so now).
    await new Promise((resolve) => setTimeout(resolve, 450));
    http
      .match('/api/github/references/acme/app/17')
      .forEach((pending) =>
        pending.flush({ message: 'x' }, { status: 404, statusText: 'x' }),
      );
  });
  const environment = (
    overrides: Partial<EnvironmentDto> = {},
  ): EnvironmentDto => ({
    id: 'e1',
    name: 'Staging',
    instructions: null,
    setupScript: null,
    model: null,
    permissionMode: null,
    repositories: [],
    isDefault: false,
    variables: [],
    files: [],
    sessions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  it('preselects the default environment with its presets and sends it', async () => {
    const { form, fixture, element } = await render(
      [repository('r1', 'acme/app'), repository('r2', 'acme/lib')],
      [
        environment({ id: 'e0', name: 'Other' }),
        environment({
          isDefault: true,
          model: 'haiku',
          permissionMode: 'plan',
          repositories: [
            { repositoryId: 'r2', baseBranch: 'release' },
            { repositoryId: 'r1' },
          ],
        }),
      ],
    );
    http
      .expectOne('/api/repositories/r2/branches')
      .flush({ defaultBranch: 'main', branches: ['main', 'release'] });
    http
      .expectOne('/api/repositories/r1/branches')
      .flush({ defaultBranch: 'main', branches: ['main'] });
    fixture.detectChanges();
    expect(
      element.querySelector('[data-testid="environment-select"]'),
    ).not.toBeNull();
    expect(form.environmentId()).toBe('e1');
    expect(form.model).toBe('haiku');
    expect(form.permissionMode).toBe('plan');
    expect(form.choices()).toEqual([
      { repositoryId: 'r2', baseBranch: 'release' },
      { repositoryId: 'r1', baseBranch: '' },
    ]);
    // Still editable.
    form.permissionMode = 'auto';
    form.prompt = 'Check the API';
    form.create();
    const request = http.expectOne({ method: 'POST', url: '/api/sessions' });
    expect(request.request.body).toEqual({
      prompt: 'Check the API',
      model: 'haiku',
      permissionMode: 'auto',
      repositories: [
        { repositoryId: 'r2', baseBranch: 'release' },
        { repositoryId: 'r1' },
      ],
      environmentId: 'e1',
    });
    request.flush(sessionDto({ id: 'new', status: 'preparing' }));
  });

  it('starts without environment when None is chosen', async () => {
    const { form } = await render(
      [repository('r1', 'acme/app')],
      [environment({ isDefault: true })],
    );
    form.chooseEnvironment('');
    form.prompt = 'Go';
    form.chooseRepository(0, 'r1');
    http
      .expectOne('/api/repositories/r1/branches')
      .flush({ defaultBranch: 'main', branches: ['main'] });
    form.create();
    const request = http.expectOne({ method: 'POST', url: '/api/sessions' });
    expect(request.request.body.environmentId).toBeUndefined();
    request.flush(sessionDto({ id: 'new', status: 'preparing' }));
  });

  /** Starts the form and answers the model list; the rest is up to the test. */
  const start = () => {
    const fixture = TestBed.createComponent(NewSessionForm);
    fixture.detectChanges();
    flushEngines(http);
    http.expectOne('/api/accounts').flush(mainAccountList());
    http.expectOne('/api/models').flush({
      models: [],
      source: 'claude-code',
      updatedAt: null,
    });
    const form = fixture.componentInstance as unknown as FormInternals;
    return { fixture, form };
  };

  it('does not apply the default environment over choices the user made', async () => {
    const { fixture, form } = start();
    http.expectOne('/api/repositories').flush({
      repositories: [
        repository('r1', 'acme/app'),
        repository('r2', 'acme/lib'),
      ],
      strayDirectories: [],
    });
    form.chooseRepository(0, 'r1');
    http
      .expectOne('/api/repositories/r1/branches')
      .flush({ defaultBranch: 'main', branches: ['main'] });
    http.expectOne('/api/environments').flush({
      environments: [
        environment({
          isDefault: true,
          model: 'haiku',
          repositories: [{ repositoryId: 'r2' }],
        }),
      ],
    });
    await fixture.whenStable();
    expect(form.touched).toBe(true);
    expect(form.environmentId()).toBe('');
    expect(form.model).toBe('');
    expect(form.choices()).toEqual([{ repositoryId: 'r1', baseBranch: '' }]);
  });

  it('drops preset repositories that are no longer registered', async () => {
    const { fixture, form } = start();
    http.expectOne('/api/environments').flush({
      environments: [
        environment({
          isDefault: true,
          repositories: [{ repositoryId: 'gone' }, { repositoryId: 'r1' }],
        }),
      ],
    });
    http
      .expectOne('/api/repositories/gone/branches')
      .flush({ message: 'x' }, { status: 404, statusText: 'x' });
    http
      .expectOne('/api/repositories/r1/branches')
      .flush({ defaultBranch: 'main', branches: ['main'] });
    expect(form.environmentId()).toBe('e1');
    http.expectOne('/api/repositories').flush({
      repositories: [repository('r1', 'acme/app')],
      strayDirectories: [],
    });
    await fixture.whenStable();
    expect(form.choices()).toEqual([{ repositoryId: 'r1', baseBranch: '' }]);
  });

  describe('with several engines', () => {
    const chatgpt = (overrides: Partial<AccountDto> = {}) =>
      accountDto({
        id: 'c1',
        provider: 'chatgpt',
        name: 'Personal',
        position: 1,
        isDefault: true,
        main: false,
        ...overrides,
      });
    const codexModels = () =>
      http.expectOne('/api/models?engine=codex').flush({
        models: [
          {
            value: null,
            label: 'Default',
            description: '',
            resolvedModel: 'gpt-5-codex',
          },
          {
            value: 'gpt-5',
            label: 'GPT-5',
            description: '',
            resolvedModel: 'gpt-5',
          },
        ],
        source: 'codex',
        updatedAt: null,
      });

    it('shows no engine choice and sends no engine with Claude Code alone', async () => {
      const { form, element } = await render([]);
      expect(element.querySelector('[data-testid="engine"]')).toBeNull();
      expect(element.textContent).toContain('What should Claude do?');
      form.prompt = 'Hi';
      form.setMode('scratch');
      form.create();
      const body = http.expectOne({ method: 'POST', url: '/api/sessions' })
        .request.body;
      expect(body.engine).toBeUndefined();
    });

    it('switches accounts, models and modes to the chosen engine', async () => {
      const { form, fixture, element } = await render([], [], {
        engines: ['claude-code', 'codex'],
        accounts: [
          accountDto(),
          chatgpt(),
          chatgpt({ id: 'c2', name: 'Work', isDefault: false, position: 2 }),
        ],
      });
      expect(element.querySelector('[data-testid="engine"]')).not.toBeNull();
      expect(form.engine()).toBe('claude-code');
      expect(form.permissionMode).toBe('auto');
      // One Claude account: no account choice.
      expect(element.querySelector('[data-testid="account"]')).toBeNull();

      form.pickEngine('codex');
      codexModels();
      fixture.detectChanges();
      expect(element.textContent).toContain('What should Codex do?');
      expect(form.permissionMode).toBe('untrusted');
      expect(form.modeOptions().map((option) => option.value)).toEqual([
        'untrusted',
        'on-request',
        'never',
      ]);
      expect(form.modelOptions().map((option) => option.label)).toEqual([
        'Default',
        'GPT-5',
      ]);
      // Two ChatGPT accounts: the choice, with their default.
      expect(element.querySelector('[data-testid="account"]')).not.toBeNull();
      expect(
        (form as unknown as { accounts(): AccountDto[] })
          .accounts()
          .map((account) => account.id),
      ).toEqual(['c1', 'c2']);
      expect(
        (
          form as unknown as { defaultAccountName(): string | null }
        ).defaultAccountName(),
      ).toBe('Personal');

      form.prompt = 'Refactor';
      form.setMode('scratch');
      form.model = 'gpt-5';
      form.accountId = 'c2';
      form.create();
      expect(
        http.expectOne({ method: 'POST', url: '/api/sessions' }).request.body,
      ).toEqual({
        prompt: 'Refactor',
        model: 'gpt-5',
        permissionMode: 'untrusted',
        scratch: true,
        accountId: 'c2',
        engine: 'codex',
      });
    });

    it('names Claude Code when it is chosen among several', async () => {
      const { form } = await render([], [], {
        engines: ['claude-code', 'codex'],
        accounts: [accountDto(), chatgpt()],
      });
      form.prompt = 'Hi';
      form.setMode('scratch');
      form.create();
      expect(
        http.expectOne({ method: 'POST', url: '/api/sessions' }).request.body,
      ).toMatchObject({ engine: 'claude-code', permissionMode: 'auto' });
    });

    it("applies an environment's model and mode only to Claude Code", async () => {
      const { form } = await render(
        [],
        [
          environment({
            isDefault: true,
            model: 'haiku',
            permissionMode: 'plan',
          }),
        ],
        {
          engines: ['claude-code', 'codex'],
          accounts: [accountDto(), chatgpt()],
        },
      );
      expect(form.model).toBe('haiku');
      expect(form.permissionMode).toBe('plan');

      form.pickEngine('codex');
      codexModels();
      expect(form.model).toBe('');
      expect(form.permissionMode).toBe('untrusted');
      // Choosing the environment again keeps Codex's own choices.
      form.chooseEnvironment('e1');
      expect(form.model).toBe('');
      expect(form.permissionMode).toBe('untrusted');

      form.pickEngine('claude-code');
      expect(form.model).toBe('haiku');
      expect(form.permissionMode).toBe('plan');
    });

    it('points to the settings while the engine has no account', async () => {
      const { form, fixture, element } = await render([], [], {
        engines: ['claude-code', 'codex'],
      });
      form.prompt = 'Hi';
      form.setMode('scratch');
      expect(element.querySelector('[data-testid="no-account"]')).toBeNull();
      form.pickEngine('codex');
      codexModels();
      fixture.detectChanges();
      expect(
        element.querySelector('[data-testid="no-account"]')?.textContent,
      ).toContain('Codex needs a ChatGPT account');
      expect(form.canStart()).toBe(false);
    });
  });
});
