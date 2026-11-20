import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
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

  it('says when the commit identity is not set', async () => {
    const { all } = await render();
    expect(all('identity-missing')[0]).toContain('cannot start');
    expect(all('author-name')).toEqual([]);
  });

  it('shows the commit identity read-only', async () => {
    const { element, all } = await render({
      gitAuthorName: 'Ada Lovelace',
      gitAuthorEmail: 'ada@example.com',
    });
    expect(all('identity-missing')).toEqual([]);
    expect(all('author-name')).toEqual(['Ada Lovelace']);
    expect(all('author-email')).toEqual(['ada@example.com']);
    expect(element.querySelector('[data-testid="save-identity"]')).toBeNull();
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
