import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type {
  RepositoryDto,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { AddRepository } from './add-repository';
import { AdditionBanners } from './addition-banners';
import { sessionDirectory, sessionDto } from './testing/session-dto';

const repository = (overrides: Partial<RepositoryDto>): RepositoryDto =>
  ({
    id: 'r2',
    owner: 'acme',
    name: 'lib',
    fullName: 'acme/lib',
    cloneUrl: 'https://example.com/acme/lib.git',
    local: false,
    github: false,
    defaultBranch: 'main',
    ...overrides,
  }) as RepositoryDto;

describe('adding repositories in the session details', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const click = async (fixture: ComponentFixture<unknown>, testId: string) => {
    (
      (fixture.nativeElement as HTMLElement).querySelector(
        `[data-testid="${testId}"]`,
      ) as HTMLButtonElement
    ).click();
    await fixture.whenStable();
  };

  describe('AddRepository', () => {
    const render = async (session: SessionDto = sessionDto()) => {
      const fixture = TestBed.createComponent(AddRepository);
      fixture.componentRef.setInput('session', session);
      const changed: SessionDto[] = [];
      fixture.componentInstance.changed.subscribe((value) =>
        changed.push(value),
      );
      await fixture.whenStable();
      return {
        fixture,
        changed,
        element: fixture.nativeElement as HTMLElement,
      };
    };

    it('adds a registered repository with a base branch', async () => {
      const { fixture, changed, element } = await render();
      await click(fixture, 'add-repository');
      http.expectOne('/api/repositories').flush({
        repositories: [
          repository({ id: 'r1', fullName: 'acme/app' }),
          repository({}),
        ],
      });
      await fixture.whenStable();
      const component = fixture.componentInstance as unknown as {
        choose(id: string): void;
        baseBranch: { set(value: string): void };
        choices(): RepositoryDto[];
      };
      // The session's own repository is not offered.
      expect(component.choices().map((entry) => entry.id)).toEqual(['r2']);
      component.choose('r2');
      http
        .expectOne('/api/repositories/r2/branches')
        .flush({ defaultBranch: 'main', branches: ['main', 'dev'] });
      component.baseBranch.set('dev');
      await fixture.whenStable();
      await click(fixture, 'add-repository-submit');
      const request = http.expectOne('/api/sessions/s1/repositories');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        repositoryId: 'r2',
        baseBranch: 'dev',
      });
      request.flush(sessionDto({ title: 'after' }));
      await fixture.whenStable();
      expect(changed.map((session) => session.title)).toEqual(['after']);
      expect(
        element.querySelector('[data-testid="add-repository-form"]'),
      ).toBeNull();
    });

    it('registers a repository by URL first, like the form', async () => {
      const { fixture, element } = await render();
      await click(fixture, 'add-repository');
      http.expectOne('/api/repositories').flush({ repositories: [] });
      await fixture.whenStable();
      await click(fixture, 'add-source-url');
      const field = element.querySelector(
        '[data-testid="add-clone-url"]',
      ) as HTMLInputElement;
      field.value = 'https://example.com/acme/tools.git';
      field.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      await click(fixture, 'add-register');
      const register = http.expectOne('/api/repositories');
      expect(register.request.body).toEqual({
        cloneUrl: 'https://example.com/acme/tools.git',
      });
      register.flush(repository({ id: 'r9', fullName: 'acme/tools' }));
      http
        .expectOne('/api/repositories/r9/branches')
        .flush({ defaultBranch: null, branches: [] });
      await fixture.whenStable();
      await click(fixture, 'add-repository-submit');
      expect(
        http.expectOne('/api/sessions/s1/repositories').request.body,
      ).toEqual({ repositoryId: 'r9' });
    });

    it('shows why the server refused', async () => {
      const { fixture, element } = await render();
      await click(fixture, 'add-repository');
      http
        .expectOne('/api/repositories')
        .flush({ repositories: [repository({})] });
      (
        fixture.componentInstance as unknown as { choose(id: string): void }
      ).choose('r2');
      http
        .expectOne('/api/repositories/r2/branches')
        .flush({ defaultBranch: 'main', branches: [] });
      await fixture.whenStable();
      await click(fixture, 'add-repository-submit');
      http
        .expectOne('/api/sessions/s1/repositories')
        .flush(
          { message: 'Set the commit identity first' },
          { status: 400, statusText: 'Bad Request' },
        );
      await fixture.whenStable();
      expect(
        element.querySelector('[data-testid="add-repository-error"]')
          ?.textContent,
      ).toContain('Set the commit identity first');
    });

    it('is not offered for archived sessions and waits while one is added', async () => {
      const archived = await render(
        sessionDto({ archivedAt: '2026-01-02T00:00:00.000Z' }),
      );
      expect(
        archived.element.querySelector('[data-testid="add-repository"]'),
      ).toBeNull();
      const adding = await render(
        sessionDto({
          directories: [
            sessionDirectory(),
            sessionDirectory({
              role: 'additional',
              path: '/w/lib',
              state: 'pending',
              addition: {
                addedAt: '2026-01-02T00:00:00.000Z',
                by: 'claude',
                state: 'preparing',
                error: null,
              },
            }),
          ],
        }),
      );
      expect(
        (
          adding.element.querySelector(
            '[data-testid="add-repository"]',
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    });
  });

  describe('AdditionBanners', () => {
    const withAddition = (
      state: 'failed' | 'held',
      error: string,
    ): SessionDto =>
      sessionDto({
        directories: [
          sessionDirectory(),
          sessionDirectory({
            role: 'additional',
            path: '/w/lib',
            repository: {
              id: 'r2',
              fullName: 'acme/lib',
              local: false,
              github: false,
            },
            state: state === 'failed' ? 'failed' : 'ready',
            setupStatus: state === 'held' ? 'failed' : 'none',
            addition: {
              addedAt: '2026-01-02T00:00:00.000Z',
              by: 'claude',
              state,
              error,
            },
          }),
        ],
      });

    const render = async (session: SessionDto) => {
      const fixture = TestBed.createComponent(AdditionBanners);
      fixture.componentRef.setInput('session', session);
      await fixture.whenStable();
      return { fixture, element: fixture.nativeElement as HTMLElement };
    };

    it('offers retry and remove for a failed clone', async () => {
      const { fixture, element } = await render(
        withAddition('failed', 'Branch dev does not exist'),
      );
      expect(element.textContent).toContain(
        'acme/lib could not be added: Branch dev does not exist.',
      );
      expect(
        element.querySelector('[data-testid="addition-accept"]'),
      ).toBeNull();
      await click(fixture, 'addition-remove');
      expect(
        http.expectOne(
          '/api/sessions/s1/repositories/r2/addition/remove?branch=claude/reply-with-pong-abc123',
        ).request.method,
      ).toBe('POST');
    });

    it('offers to run the setup again or use it anyway when held', async () => {
      const { fixture, element } = await render(
        withAddition('held', 'The setup script failed'),
      );
      expect(element.textContent).toContain(
        'The setup script of acme/lib failed',
      );
      await click(fixture, 'addition-accept');
      http
        .expectOne(
          '/api/sessions/s1/repositories/r2/addition/accept?branch=claude/reply-with-pong-abc123',
        )
        .flush(sessionDto());
      await fixture.whenStable();
      await click(fixture, 'addition-retry');
      http.expectOne(
        '/api/sessions/s1/repositories/r2/addition/retry?branch=claude/reply-with-pong-abc123',
      );
    });
  });
});
