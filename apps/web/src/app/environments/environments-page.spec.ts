import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { EnvironmentDto } from '@claude-remote-manager/shared-types';
import { EnvironmentsPage } from './environments-page';

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

describe('EnvironmentsPage', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EnvironmentsPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  const render = async (environments: EnvironmentDto[]) => {
    const fixture = TestBed.createComponent(EnvironmentsPage);
    fixture.detectChanges();
    http.expectOne('/api/environments').flush({ environments });
    await settle(fixture);
    return { fixture, element: fixture.nativeElement as HTMLElement };
  };

  const settle = async (fixture: ComponentFixture<EnvironmentsPage>) => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  /** Requests of the editor: models and repositories. */
  const flushEditor = () => {
    for (const request of http.match('/api/models')) {
      request.flush({ models: [], source: 'fallback', updatedAt: null });
    }
    http
      .expectOne('/api/repositories')
      .flush({ repositories: [], strayDirectories: [] });
  };

  const type = (element: HTMLElement, testId: string, value: string) => {
    const field = element.querySelector<HTMLInputElement>(
      `[data-testid="${testId}"]`,
    );
    if (!field) {
      throw new Error(`${testId} not found`);
    }
    field.value = value;
    field.dispatchEvent(new Event('input'));
  };

  const click = (element: HTMLElement, testId: string) => {
    const button = element.querySelector<HTMLElement>(
      `[data-testid="${testId}"]`,
    );
    if (!button) {
      throw new Error(`${testId} not found`);
    }
    button.click();
  };

  it('lists environments with what they hold', async () => {
    const { element } = await render([
      environment({
        isDefault: true,
        variables: [
          { id: 'v', name: 'KEY', secret: true, value: null, length: 10 },
        ],
        sessions: [
          { id: 's1', title: 'One', archived: false },
          { id: 's2', title: 'Two', archived: true },
        ],
      }),
    ]);
    const item = element.querySelector('[data-testid="environment"]');
    expect(item?.textContent).toContain('Staging');
    expect(item?.textContent).toContain('Default');
    expect(item?.textContent).toContain('1 variable');
    expect(item?.textContent).toContain('0 files');
    expect(item?.textContent).toContain('used by 1 session');
  });

  it('creates an environment with a secret variable', async () => {
    const { fixture, element } = await render([]);
    expect(element.textContent).toContain('No environments yet.');
    click(element, 'new-environment');
    await settle(fixture);
    flushEditor();
    await settle(fixture);
    type(element, 'environment-name', 'Prod');
    click(element, 'add-variable');
    await settle(fixture);
    // The value of a secret is typed like a password.
    expect(
      element.querySelector<HTMLInputElement>('[data-testid="variable-value"]')
        ?.type,
    ).toBe('password');
    type(element, 'variable-name', 'STRIPE_KEY');
    type(element, 'variable-value', 'sk_live_123');
    await settle(fixture);
    click(element, 'environment-save');
    const request = http.expectOne({
      method: 'POST',
      url: '/api/environments',
    });
    expect(request.request.body).toEqual(
      expect.objectContaining({
        name: 'Prod',
        variables: [{ name: 'STRIPE_KEY', secret: true, value: 'sk_live_123' }],
        files: [],
      }),
    );
    request.flush(environment({ id: 'e2', name: 'Prod' }));
    http
      .expectOne('/api/environments')
      .flush({ environments: [environment({ id: 'e2', name: 'Prod' })] });
    await settle(fixture);
    expect(
      element.querySelector('[data-testid="environment-editor"]'),
    ).toBeNull();
    expect(element.textContent).toContain('Prod');
  });

  it('does not save invalid entries', async () => {
    const { fixture, element } = await render([]);
    click(element, 'new-environment');
    await settle(fixture);
    flushEditor();
    await settle(fixture);
    type(element, 'environment-name', 'Prod');
    click(element, 'add-variable');
    await settle(fixture);
    type(element, 'variable-name', 'PATH');
    await settle(fixture);
    click(element, 'environment-save');
    await settle(fixture);
    expect(
      element.querySelector('[data-testid="variable-problem"]')?.textContent,
    ).toContain('set by the session');
  });

  it('keeps stored secrets of an existing environment', async () => {
    const { fixture, element } = await render([
      environment({
        variables: [
          { id: 'v1', name: 'KEY', secret: true, value: null, length: 12 },
        ],
      }),
    ]);
    click(element, 'environment-open');
    await settle(fixture);
    flushEditor();
    await settle(fixture);
    expect(
      element.querySelector('[data-testid="variable-stored"]')?.textContent,
    ).toContain('Set (12 characters)');
    expect(element.querySelector('[data-testid="variable-value"]')).toBeNull();
    click(element, 'environment-save');
    const request = http.expectOne({
      method: 'PUT',
      url: '/api/environments/e1',
    });
    expect(request.request.body.variables).toEqual([
      { id: 'v1', name: 'KEY', secret: true },
    ]);
    request.flush(environment());
    http
      .expectOne('/api/environments')
      .flush({ environments: [environment()] });
  });

  it('opens the environment named in the address', async () => {
    await TestBed.inject(Router).navigateByUrl('/?id=e1');
    const { fixture, element } = await render([
      environment({
        variables: [
          { id: 'v1', name: 'KEY', secret: true, value: null, length: 12 },
        ],
      }),
    ]);
    flushEditor();
    await settle(fixture);
    expect(
      element.querySelector('[data-testid="variable-stored"]'),
    ).not.toBeNull();
  });

  it('shows why an environment cannot be deleted', async () => {
    const { fixture, element } = await render([
      environment({ sessions: [{ id: 's1', title: 'Busy', archived: false }] }),
    ]);
    click(element, 'environment-delete');
    await settle(fixture);
    const dialog = element.querySelector(
      '[data-testid="environment-delete-dialog"]',
    );
    expect(dialog?.textContent).toContain('Busy');
    click(element, 'environment-delete-confirm');
    http
      .expectOne({ method: 'DELETE', url: '/api/environments/e1' })
      .flush(
        { message: 'Used by sessions: Busy' },
        { status: 409, statusText: 'Conflict' },
      );
    await settle(fixture);
    expect(
      element.querySelector('[data-testid="environment-delete-error"]')
        ?.textContent,
    ).toContain('Used by sessions: Busy');
  });

  it('deletes an environment', async () => {
    const { fixture, element } = await render([environment()]);
    click(element, 'environment-delete');
    await settle(fixture);
    click(element, 'environment-delete-confirm');
    http
      .expectOne({ method: 'DELETE', url: '/api/environments/e1' })
      .flush(null, { status: 204, statusText: 'No Content' });
    await settle(fixture);
    expect(element.querySelector('[data-testid="environment"]')).toBeNull();
  });
});
