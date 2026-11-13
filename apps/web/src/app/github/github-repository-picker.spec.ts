import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type {
  GitHubRepositoryDto,
  RepositoryDto,
} from '@claude-remote-manager/shared-types';
import {
  GitHubRepositoryPicker,
  SEARCH_DEBOUNCE_MS,
} from './github-repository-picker';

interface PickerInternals {
  search(query: unknown): void;
  choose(repository: GitHubRepositoryDto): void;
  results(): GitHubRepositoryDto[];
  message(): string | null;
}

const githubRepository: GitHubRepositoryDto = {
  id: 99,
  installationId: 1,
  owner: 'acme',
  name: 'app',
  fullName: 'acme/app',
  private: true,
  archived: false,
  defaultBranch: 'main',
  description: null,
  pushedAt: null,
  htmlUrl: 'https://github.com/acme/app',
  registeredRepositoryId: null,
};

describe('GitHubRepositoryPicker', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
      ],
    });
    await TestBed.configureTestingModule({
      imports: [GitHubRepositoryPicker],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  const render = () => {
    const fixture = TestBed.createComponent(GitHubRepositoryPicker);
    fixture.detectChanges();
    const picked: RepositoryDto[] = [];
    fixture.componentInstance.picked.subscribe((repository) =>
      picked.push(repository),
    );
    return {
      fixture,
      picker: fixture.componentInstance as unknown as PickerInternals,
      picked,
    };
  };

  it('searches after a pause and registers the chosen repository', () => {
    const { picker, picked } = render();
    picker.search('ac');
    picker.search('acme');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    const search = http.expectOne(
      (request) => request.url === '/api/github/repositories',
    );
    expect(search.request.params.get('query')).toBe('acme');
    search.flush({
      repositories: [githubRepository],
      total: 1,
      page: 1,
      perPage: 20,
      fetchedAt: '2026-01-01T00:00:00Z',
      errors: [],
    });
    expect(picker.results()).toEqual([githubRepository]);

    picker.choose(githubRepository);
    const register = http.expectOne({
      method: 'POST',
      url: '/api/repositories',
    });
    expect(register.request.body).toEqual({ githubRepositoryId: 99 });
    register.flush({ id: 'r1', fullName: 'acme/app' });
    expect(picked.map((repository) => repository.id)).toEqual(['r1']);
  });

  it('does not search for the chosen option itself', () => {
    const { picker } = render();
    // The autocomplete writes the chosen repository into the field.
    picker.search(githubRepository);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    http.expectNone((request) => request.url === '/api/github/repositories');
  });

  it('says when GitHub is not configured', () => {
    const { picker } = render();
    picker.search('');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    http
      .expectOne((request) => request.url === '/api/github/repositories')
      .flush(
        {
          message: 'The GitHub App is not configured: GITHUB_APP_ID is not set',
        },
        { status: 503, statusText: 'Service Unavailable' },
      );
    expect(picker.message()).toContain('not configured');
  });
});
