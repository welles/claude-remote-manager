import {
  Component,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type {
  GitHubRepositoryDto,
  RepositoryDto,
} from '@claude-remote-manager/shared-types';
import { Subject, debounceTime, switchMap, catchError, of, map } from 'rxjs';
import {
  RepositoriesApi,
  errorMessage,
} from '../repositories/repositories-api';
import { GitHubApi } from './github-api';

/** Delay between typing and asking the server. */
export const SEARCH_DEBOUNCE_MS = 250;
const PAGE_SIZE = 20;

/**
 * Search field over all repositories the GitHub App's installations can
 * access (personal account and organizations). Choosing one registers it
 * (idempotent; cloning starts in the background) and emits the registered
 * repository.
 */
@Component({
  selector: 'app-github-repository-picker',
  host: { class: 'block' },
  imports: [
    FormsModule,
    MatAutocompleteModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  templateUrl: './github-repository-picker.html',
})
export class GitHubRepositoryPicker {
  private readonly github = inject(GitHubApi);
  private readonly repositoriesApi = inject(RepositoriesApi);

  readonly label = input('Add a repository from GitHub');
  /** A GitHub repository was chosen and is registered. */
  readonly picked = output<RepositoryDto>();

  protected query = '';
  protected readonly results = signal<GitHubRepositoryDto[]>([]);
  protected readonly total = signal(0);
  protected readonly message = signal<string | null>(null);
  protected readonly registering = signal(false);

  private readonly searches = new Subject<string>();

  constructor() {
    const subscription = this.searches
      .pipe(
        debounceTime(SEARCH_DEBOUNCE_MS),
        switchMap((query) =>
          this.github.repositories(query, { perPage: PAGE_SIZE }).pipe(
            map((response) => ({ response, error: null })),
            catchError((error: unknown) =>
              of({
                response: null,
                error: errorMessage(error, 'GitHub could not be asked.'),
              }),
            ),
          ),
        ),
      )
      .subscribe(({ response, error }) => {
        this.results.set(response?.repositories ?? []);
        this.total.set(response?.total ?? 0);
        this.message.set(
          error ??
            (response && response.errors.length > 0
              ? response.errors.join('; ')
              : null),
        );
      });
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  }

  /** The field's value: typed text, or the chosen repository (ignored). */
  protected search(query: unknown): void {
    if (typeof query === 'string') {
      this.searches.next(query.trim());
    }
  }

  protected display(repository: GitHubRepositoryDto | string | null): string {
    return typeof repository === 'string'
      ? repository
      : (repository?.fullName ?? '');
  }

  protected choose(repository: GitHubRepositoryDto): void {
    this.registering.set(true);
    this.message.set(null);
    this.repositoriesApi.registerGitHub(repository.id).subscribe({
      next: (registered) => {
        this.registering.set(false);
        this.query = '';
        this.results.set([]);
        this.picked.emit(registered);
      },
      error: (error: unknown) => {
        this.registering.set(false);
        this.message.set(
          errorMessage(error, `${repository.fullName} could not be added.`),
        );
      },
    });
  }
}
