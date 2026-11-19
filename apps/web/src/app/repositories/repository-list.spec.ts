import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { RepositoryDto } from '@claude-remote-manager/shared-types';
import { words } from '../testing/text';
import { ACTIVITY_POLL_MS, RepositoryList } from './repository-list';
import { Toasts } from '../ui/toasts';

const repository = (overrides: Partial<RepositoryDto> = {}): RepositoryDto => ({
  id: 'r1',
  owner: 'acme',
  name: 'app',
  fullName: 'acme/app',
  cloneUrl: 'https://github.com/acme/app.git',
  local: false,
  github: null,
  defaultBranch: 'main',
  localPath: '/data/repos/acme/app',
  setupScript: 'npm ci',
  clonedAt: '2026-01-01T00:00:00.000Z',
  fetchedAt: '2026-01-01T00:00:00.000Z',
  lastError: null,
  activity: null,
  clones: [
    {
      path: '/data/workspace/sessions/fix-login-abc123/acme/app',
      branch: 'claude/fix-login-abc123',
      sessionId: 's1',
      sessionTitle: 'Fix login',
      orphaned: false,
      missing: false,
    },
    {
      path: '/data/workspace/sessions/leftover/acme/app',
      branch: 'claude/leftover',
      sessionId: null,
      sessionTitle: null,
      orphaned: true,
      missing: false,
    },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

interface ListInternals {
  cloneUrl: string;
  projectName: string;
  addProject(): void;
  setupDraft: string;
  add(): void;
  fetch(repository: RepositoryDto): void;
  editSetup(repository: RepositoryDto): void;
  saveSetup(repository: RepositoryDto): void;
  openPublish(repository: RepositoryDto): void;
  publish(repository: RepositoryDto): void;
  publishMode: 'create' | 'attach';
  publishOwner: string;
  publishExisting: string;
  owners(): { account: string }[];
}

describe('RepositoryList', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await TestBed.configureTestingModule({
      imports: [RepositoryList],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  const render = async (
    repositories: RepositoryDto[],
    strayDirectories: string[] = [],
  ) => {
    const fixture = TestBed.createComponent(RepositoryList);
    fixture.detectChanges();
    http
      .expectOne('/api/repositories')
      .flush({ repositories, strayDirectories });
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const all = (testId: string) =>
      [...element.querySelectorAll(`[data-testid="${testId}"]`)].map((node) =>
        words(node),
      );
    const list = fixture.componentInstance as unknown as ListInternals;
    return { fixture, element, all, list };
  };

  it('shows repositories with default branch, setup script and session clones', async () => {
    const { all } = await render(
      [
        repository(),
        repository({
          id: 'p1',
          owner: 'local',
          name: 'tool',
          fullName: 'local/tool',
          cloneUrl: null,
          local: true,
          localPath: '/data/workspace/repos/local/tool',
          setupScript: null,
          clones: [],
        }),
      ],
      ['/data/workspace/scratch/old'],
    );

    expect(all('repository')[0]).toContain('acme/app');
    expect(all('repository')[0]).toContain('Default branch main');
    expect(all('setup-script')).toEqual(['npm ci']);
    expect(all('clone')).toEqual([
      'Fix login claude/fix-login-abc123 /data/workspace/sessions/fix-login-abc123/acme/app',
      'leftover Orphaned claude/leftover /data/workspace/sessions/leftover/acme/app',
    ]);
    expect(all('repository')[1]).toContain(
      'Local project no remote · /data/workspace/repos/local/tool',
    );
    expect(all('stray')).toEqual(['/data/workspace/scratch/old']);
  });

  it('adds a repository and polls while it is cloned', async () => {
    const { fixture, list, all } = await render([]);
    list.cloneUrl = ' https://github.com/acme/app.git ';
    list.add();
    const request = http.expectOne({
      method: 'POST',
      url: '/api/repositories',
    });
    expect(request.request.body).toEqual({
      cloneUrl: 'https://github.com/acme/app.git',
    });
    request.flush(
      repository({
        activity: 'cloning',
        clonedAt: null,
        defaultBranch: null,
        clones: [],
      }),
    );
    fixture.detectChanges();
    expect(all('activity')).toEqual(['Cloning…']);
    expect(list.cloneUrl).toBe('');

    vi.advanceTimersByTime(ACTIVITY_POLL_MS);
    http.expectOne('/api/repositories').flush({
      repositories: [repository({ clones: [] })],
      strayDirectories: [],
    });
    fixture.detectChanges();
    expect(all('activity')).toEqual([]);
    // Nothing runs any more: no further polling.
    vi.advanceTimersByTime(ACTIVITY_POLL_MS * 2);
    http.expectNone('/api/repositories');
  });

  it('shows why a repository could not be added', async () => {
    const { fixture, list, all } = await render([]);
    list.cloneUrl = 'http://example.com/a/b';
    list.add();
    http.expectOne({ method: 'POST', url: '/api/repositories' }).flush(
      {
        message: 'Unsupported protocol http; use https, ssh or a local path',
      },
      { status: 400, statusText: 'Bad Request' },
    );
    fixture.detectChanges();
    expect(all('add-error')).toEqual([
      'Unsupported protocol http; use https, ssh or a local path',
    ]);
  });

  it('edits the setup script and starts fetches', async () => {
    const current = repository();
    const { fixture, list, all } = await render([current]);
    list.editSetup(current);
    fixture.detectChanges();
    expect(all('setup-input')).toHaveLength(1);
    list.setupDraft = 'npm ci\nnpm run build';
    list.saveSetup(current);
    const patch = http.expectOne({
      method: 'PATCH',
      url: '/api/repositories/r1',
    });
    expect(patch.request.body).toEqual({
      setupScript: 'npm ci\nnpm run build',
    });
    patch.flush(repository({ setupScript: 'npm ci\nnpm run build' }));
    fixture.detectChanges();
    expect(all('setup-input')).toHaveLength(0);
    expect(all('setup-script')).toEqual(['npm ci npm run build']);
    expect(TestBed.inject(Toasts).all()).toMatchObject([
      { title: 'Setup script of acme/app saved' },
    ]);

    list.fetch(current);
    http
      .expectOne({ method: 'POST', url: '/api/repositories/r1/fetch' })
      .flush(repository({ activity: 'fetching' }));
    fixture.detectChanges();
    expect(all('activity')).toEqual(['Fetching…']);
    vi.advanceTimersByTime(ACTIVITY_POLL_MS);
    http.expectOne('/api/repositories').flush({
      repositories: [repository({ lastError: 'git fetch failed: offline' })],
      strayDirectories: [],
    });
    fixture.detectChanges();
    expect(all('repository-error')).toEqual(['git fetch failed: offline']);
  });

  it('creates local projects', async () => {
    const { list } = await render([]);
    list.projectName = ' my-tool ';
    list.addProject();
    const request = http.expectOne({
      method: 'POST',
      url: '/api/repositories',
    });
    expect(request.request.body).toEqual({ projectName: 'my-tool' });
    request.flush(
      repository({
        id: 'p1',
        fullName: 'local/my-tool',
        cloneUrl: null,
        local: true,
        clones: [],
      }),
    );
    expect(list.projectName).toBe('');
    vi.advanceTimersByTime(ACTIVITY_POLL_MS);
    http.expectOne('/api/repositories').flush({
      repositories: [],
      strayDirectories: [],
    });
  });

  describe('putting a local project on GitHub', () => {
    const project = () =>
      repository({
        id: 'p1',
        owner: 'local',
        name: 'tool',
        fullName: 'local/tool',
        cloneUrl: null,
        local: true,
        clones: [],
      });
    const status = (accounts: [string, string][]) => ({
      configured: true,
      installations: accounts.map(([account, accountType], id) => ({
        id,
        account,
        accountType,
        repositorySelection: 'all',
        repositoryCount: 1,
        settingsUrl: null,
        error: null,
      })),
    });

    it('creates repositories only in organizations', async () => {
      const { list } = await render([project()]);
      list.openPublish(project());
      http.expectOne('/api/github/status').flush(
        status([
          ['alice', 'User'],
          ['acme', 'Organization'],
        ]),
      );
      expect(list.owners().map((owner) => owner.account)).toEqual(['acme']);
      expect(list.publishMode).toBe('create');
      list.publish(project());
      const request = http.expectOne('/api/repositories/p1/github');
      expect(request.request.body).toEqual({
        mode: 'create',
        owner: 'acme',
        name: 'tool',
        private: true,
      });
      request.flush(project());
    });

    it('offers only attaching when the app is installed on the personal account alone', async () => {
      const { list, fixture, all } = await render([project()]);
      list.openPublish(project());
      http.expectOne('/api/github/status').flush(status([['alice', 'User']]));
      fixture.detectChanges();
      expect(list.publishMode).toBe('attach');
      expect(all('attach-hint')[0]).toContain(
        'create an empty repository on GitHub',
      );
      list.publishExisting = 'alice/tool';
      list.publish(project());
      http
        .expectOne((request) => request.url === '/api/github/repositories')
        .flush({
          repositories: [{ id: 7, fullName: 'alice/tool' }],
          total: 1,
          page: 1,
          perPage: 100,
          fetchedAt: '',
          errors: [],
        });
      const attach = http.expectOne('/api/repositories/p1/github');
      expect(attach.request.body).toEqual({
        mode: 'attach',
        githubRepositoryId: 7,
      });
      attach.flush(project());
    });
  });
});
