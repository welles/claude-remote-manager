import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  RepositoryDto,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { NewSessionForm, type RepositoryChoice } from './new-session-form';
import { sessionDto } from './testing/session-dto';

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

  const render = async (repositories: RepositoryDto[]) => {
    const fixture = TestBed.createComponent(NewSessionForm);
    const created: SessionDto[] = [];
    fixture.componentInstance.created.subscribe((session) =>
      created.push(session),
    );
    fixture.detectChanges();
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
    const textarea = element.querySelector(
      '[data-testid="new-prompt"]',
    ) as HTMLTextAreaElement;
    textarea.value = 'Fix #1';
    textarea.setSelectionRange(6, 6);
    textarea.dispatchEvent(new Event('input'));
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
});
