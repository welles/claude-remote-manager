import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { GitHubStatusDto } from '@claude-remote-manager/shared-types';
import { words } from '../testing/text';
import { notificationStatus } from './testing/notification-status';
import { SettingsPage } from './settings-page';

const status = (overrides: Partial<GitHubStatusDto> = {}): GitHubStatusDto => ({
  configured: true,
  problem: null,
  appId: '42',
  appName: 'My App',
  appSlug: 'my-app',
  appUrl: 'https://github.com/apps/my-app',
  installUrl: 'https://github.com/apps/my-app/installations/new',
  installations: [
    {
      id: 1,
      account: 'alice',
      accountType: 'User',
      repositorySelection: 'all',
      repositoryCount: 12,
      settingsUrl: 'https://github.com/settings/installations/1',
      error: null,
    },
    {
      id: 2,
      account: 'acme',
      accountType: 'Organization',
      repositorySelection: 'selected',
      repositoryCount: 3,
      settingsUrl: null,
      error: null,
    },
  ],
  error: null,
  ...overrides,
});

describe('SettingsPage', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  const render = async (
    settings = {
      gitAuthorName: null as string | null,
      gitAuthorEmail: null as string | null,
    },
    github: GitHubStatusDto = status(),
  ) => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    http.expectOne('/api/settings').flush(settings);
    http.expectOne('/api/github/status').flush(github);
    http.expectOne('/api/notifications').flush(notificationStatus());
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const all = (testId: string) =>
      [...element.querySelectorAll(`[data-testid="${testId}"]`)].map((node) =>
        words(node),
      );
    return { fixture, element, all };
  };

  it('asks for the commit identity and saves it', async () => {
    const { fixture, element, all } = await render();
    expect(all('identity-missing')).toHaveLength(1);
    const type = (testId: string, value: string) => {
      const input = element.querySelector(
        `[data-testid="${testId}"]`,
      ) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    type('author-name', 'Ada Lovelace');
    type('author-email', 'ada@example.com');
    fixture.detectChanges();
    (
      element.querySelector('[data-testid="save-identity"]') as HTMLElement
    ).click();
    const request = http.expectOne({ method: 'PUT', url: '/api/settings' });
    expect(request.request.body).toEqual({
      gitAuthorName: 'Ada Lovelace',
      gitAuthorEmail: 'ada@example.com',
    });
    request.flush(request.request.body);
    fixture.detectChanges();
    expect(all('identity-missing')).toEqual([]);
    expect(all('settings-message')[0]).toContain('Saved');
  });

  it('shows the GitHub App with its installations and an install link', async () => {
    const { element, all } = await render({
      gitAuthorName: 'Ada',
      gitAuthorEmail: 'ada@example.com',
    });
    expect(all('github-app')).toEqual(['My App']);
    expect(all('installation')).toEqual([
      'alice account · all repositories · 12 accessible Configure',
      'acme organization · selected repositories · 3 accessible',
    ]);
    expect(
      (
        element.querySelector(
          '[data-testid="install-app"]',
        ) as HTMLAnchorElement
      ).href,
    ).toBe('https://github.com/apps/my-app/installations/new');
  });

  it('says when GitHub is not configured', async () => {
    const { all } = await render(
      undefined,
      status({
        configured: false,
        problem: 'GITHUB_APP_ID is not set',
        installations: [],
        installUrl: null,
      }),
    );
    expect(all('github-not-configured')[0]).toContain(
      'GITHUB_APP_ID is not set',
    );
  });
});
