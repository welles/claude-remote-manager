import { computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, debounceTime, of, Subject, switchMap } from 'rxjs';
import {
  isRepositoryFullName,
  type GitHubReferenceSearchResponse,
  type GitHubReferenceSummary,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { ReferencesApi } from './references-api';
import type { TextField } from '../markdown/text-field';

/** A `#` reference being typed before the caret. */
export interface ReferenceQuery {
  /** Where the reference starts (its repository part, if any). */
  start: number;
  /** `owner/repo` typed before `#`, else `null`. */
  repository: string | null;
  /** What follows `#`: a number, a word of the title, or nothing. */
  text: string;
}

/** `#…` or `owner/repo#…` right before the caret, after a space or `(`. */
const QUERY =
  /(?:^|[\s([])((?:([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+))?#([^\s#@]*))$/;

/** The `#` reference being typed at the end of `before`, if any. */
export function referenceQuery(before: string): ReferenceQuery | null {
  const match = QUERY.exec(before);
  if (!match) {
    return null;
  }
  return {
    start: before.length - match[1].length,
    repository: match[2] ?? null,
    text: match[3],
  };
}

/**
 * `#` autocomplete of a text field: searches the issues and pull requests
 * of the given repositories (or of `owner/repo` typed before `#`) by
 * number and title, and inserts `#12` when the session has one
 * repository, else `owner/repo#12`. Create it in a component's field
 * initializer.
 */
export class ReferenceAutocomplete {
  private readonly api = inject(ReferencesApi);
  readonly query = signal<ReferenceQuery | null>(null);
  readonly suggestions = signal<GitHubReferenceSummary[]>([]);
  /** Repositories that could not be searched, with the reason. */
  readonly errors = signal<string[]>([]);
  readonly active = signal(0);
  readonly open = computed(
    () =>
      this.query() !== null &&
      (this.suggestions().length > 0 || this.errors().length > 0),
  );
  private readonly requests = new Subject<{
    text: string;
    repositories: string[];
  }>();

  /**
   * @param repositories the repositories `#` searches, the main one first
   * @param changed gets the field's new value after a choice
   */
  constructor(
    private readonly repositories: () => string[],
    private readonly changed: (value: string) => void,
  ) {
    this.requests
      .pipe(
        debounceTime(150),
        switchMap(({ text, repositories }) =>
          repositories.length === 0
            ? of<GitHubReferenceSearchResponse>({ results: [], errors: [] })
            : this.api.search(text, repositories).pipe(
                catchError((error: unknown) =>
                  of<GitHubReferenceSearchResponse>({
                    results: [],
                    errors: [
                      errorMessage(error, 'GitHub could not be searched'),
                    ],
                  }),
                ),
              ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((response) => {
        if (this.query() === null) {
          return;
        }
        this.suggestions.set(response.results);
        this.errors.set(response.errors);
        this.active.set(0);
      });
  }

  /**
   * Looks for a `#` reference before the caret; returns whether one is
   * being typed (then other autocompletes should stay closed).
   */
  update(field: TextField): boolean {
    if (field.selectionStart !== field.selectionEnd) {
      this.close();
      return false;
    }
    const query = referenceQuery(field.value.slice(0, field.selectionStart));
    const repositories = query?.repository
      ? isRepositoryFullName(query.repository)
        ? [query.repository]
        : []
      : this.repositories();
    if (!query || repositories.length === 0) {
      this.close();
      return false;
    }
    const current = this.query();
    if (
      current?.start !== query.start ||
      current.text !== query.text ||
      current.repository !== query.repository
    ) {
      this.query.set(query);
      this.requests.next({ text: query.text, repositories });
    }
    return true;
  }

  /** Arrow keys, Enter/Tab to choose, Escape; returns whether it handled it. */
  keydown(event: KeyboardEvent, field: TextField): boolean {
    const count = this.suggestions().length;
    if (!this.open()) {
      return false;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.active.update((index) => (index + 1) % Math.max(count, 1));
        return true;
      case 'ArrowUp':
        event.preventDefault();
        this.active.update(
          (index) => (index - 1 + Math.max(count, 1)) % Math.max(count, 1),
        );
        return true;
      case 'Enter':
      case 'Tab': {
        const item = this.suggestions()[this.active()];
        if (!item) {
          return false;
        }
        event.preventDefault();
        this.choose(item, field);
        return true;
      }
      case 'Escape':
        event.preventDefault();
        this.close();
        return true;
    }
    return false;
  }

  /**
   * Replaces the reference being typed with the chosen one and places the
   * caret after it.
   */
  choose(item: GitHubReferenceSummary, field: TextField): void {
    const query = this.query();
    const value = field.value;
    if (!query) {
      return;
    }
    // With several repositories `#12` could mean more than one item.
    const repositories = this.repositories();
    const token =
      !query.repository &&
      repositories.length === 1 &&
      item.repository.toLowerCase() === repositories[0].toLowerCase()
        ? `#${item.number}`
        : `${item.repository}#${item.number}`;
    const end = field.selectionStart;
    const inserted = `${token} `;
    const next = value.slice(0, query.start) + inserted + value.slice(end);
    field.value = next;
    const caret = query.start + inserted.length;
    field.setSelectionRange(caret, caret);
    field.focus();
    this.close();
    this.changed(next);
  }

  close(): void {
    this.query.set(null);
    this.suggestions.set([]);
    this.errors.set([]);
  }
}
