import {
  Component,
  DestroyRef,
  inject,
  output,
  signal,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { AppDatePipe } from '../ui/dates';
import { AppIcon } from '../ui/icon';
import { RouterLink } from '@angular/router';
import {
  Subject,
  debounceTime,
  distinctUntilChanged,
  switchMap,
  of,
  catchError,
} from 'rxjs';
import {
  SEARCH_QUERY_MAX_LENGTH,
  type SearchMatch,
  type SearchResponse,
} from '@claude-remote-manager/shared-types';
import { SessionsApi } from './sessions-api';

const KIND_LABELS: Record<SearchMatch['kind'], string> = {
  title: 'Title',
  repository: 'Repository',
  branch: 'Branch',
  user: 'You',
  assistant: 'Claude',
};

/** A snippet split into plain and highlighted parts (no HTML involved). */
export function snippetParts(
  match: SearchMatch,
): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  let position = 0;
  for (const [from, to] of match.highlights) {
    if (from > position) {
      parts.push({ text: match.snippet.slice(position, from), hit: false });
    }
    parts.push({ text: match.snippet.slice(from, to), hit: true });
    position = to;
  }
  if (position < match.snippet.length) {
    parts.push({ text: match.snippet.slice(position), hit: false });
  }
  return parts;
}

/**
 * Search over all sessions (archived ones too): titles, repositories,
 * branches and the conversation. While a query is entered the results
 * replace the session list (`active`); a result opens the session at the
 * matching message.
 */
@Component({
  selector: 'app-session-search',
  imports: [
    AppDatePipe,
    FormsModule,
    AppIcon,
    MatProgressBarModule,
    RouterLink,
  ],
  template: `
    <label class="field">
      <app-icon name="search" />
      <input
        type="search"
        [maxlength]="maxLength"
        [ngModel]="query()"
        (ngModelChange)="changed($event)"
        placeholder="Search sessions"
        aria-label="Search sessions: titles, repositories, branches and the conversation"
        enterkeyhint="search"
        data-testid="search-input"
      />
    </label>
    @if (query().trim()) {
      @if (busy()) {
        <mat-progress-bar mode="indeterminate" />
      }
      @if (error(); as text) {
        <p class="error">{{ text }}</p>
      } @else if (result(); as result) {
        @if (result.hits.length === 0 && !busy()) {
          <p class="empty" data-testid="search-empty">No session matches.</p>
        }
        <nav class="hits">
          @for (hit of result.hits; track hit.sessionId) {
            <a
              class="hit"
              [routerLink]="['/sessions', hit.sessionId]"
              [queryParams]="linkParams(hit.matches[0])"
              data-testid="search-hit"
            >
              <span class="title"
                >{{ hit.title || 'Untitled session' }}
                @if (hit.archivedAt) {
                  <span class="app-tag">Archived</span>
                }
              </span>
              <span class="meta"
                >{{ hit.updatedAt | appDate: 'relative' }}
                @if (hit.repositories.length > 0) {
                  · {{ hit.repositories.join(' + ') }}
                }
                @if (hit.matchCount > hit.matches.length) {
                  · {{ hit.matchCount }} matches
                }
              </span>
              @for (match of hit.matches; track $index) {
                <!-- One line: whitespace here would show up around the highlights. -->
                <!-- prettier-ignore -->
                <span class="match" data-testid="search-match"><span class="app-tag kind">{{ kindLabels[match.kind] }}</span>@for (part of parts(match); track $index) {@if (part.hit) {<mark>{{ part.text }}</mark>} @else {<span>{{ part.text }}</span>}}</span>
              }
            </a>
          }
        </nav>
        @if (result.truncated) {
          <p class="empty">More sessions match; add words to narrow it down.</p>
        }
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .field {
      display: flex;
      align-items: center;
      gap: var(--app-space-2);
      height: 40px;
      padding: 0 var(--app-space-3);
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-small);
      background: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface-variant);
      cursor: text;
    }
    .field:focus-within {
      border-color: var(--mat-sys-primary);
    }
    input {
      flex: 1;
      min-width: 0;
      height: 100%;
      border: 0;
      outline: none;
      background: none;
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-large);
    }
    input::placeholder {
      color: var(--mat-sys-on-surface-variant);
    }
    mat-progress-bar {
      margin-top: var(--app-space-2);
    }
    .hits {
      display: flex;
      flex-direction: column;
      margin-top: var(--app-space-3);
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-medium);
      background: var(--mat-sys-surface-container-low);
      overflow: hidden;
    }
    .hits:empty {
      display: none;
    }
    .hit {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      color: inherit;
      text-decoration: none;
      overflow-wrap: anywhere;
    }
    .hit:last-child {
      border-bottom: 0;
    }
    .hit:hover,
    .hit:focus-visible {
      background: var(--mat-sys-surface-container);
    }
    .title {
      font-weight: 500;
    }
    .meta,
    .empty {
      color: var(--mat-sys-on-surface-variant);
    }
    .match {
      font: var(--mat-sys-body-small);
    }
    .kind {
      margin-right: 6px;
    }
    mark {
      background: color-mix(in srgb, var(--mat-sys-primary) 30%, transparent);
      color: inherit;
    }
    .error {
      color: var(--mat-sys-error);
    }
  `,
})
export class SessionSearch implements OnInit {
  private readonly api = inject(SessionsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly queries = new Subject<string>();

  /** Whether a query is entered (the results replace the list). */
  readonly active = output<boolean>();

  protected readonly maxLength = SEARCH_QUERY_MAX_LENGTH;
  protected readonly kindLabels = KIND_LABELS;
  protected readonly parts = snippetParts;
  protected readonly query = signal('');
  protected readonly result = signal<SearchResponse | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.queries
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((query) => {
          if (!query.trim()) {
            return of(null);
          }
          this.busy.set(true);
          return this.api.search(query).pipe(
            catchError(() => {
              this.error.set('The search failed.');
              return of(null);
            }),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((result) => {
        this.busy.set(false);
        if (result) {
          this.error.set(null);
        }
        this.result.set(result);
      });
  }

  protected changed(query: string): void {
    this.query.set(query);
    this.active.emit(query.trim().length > 0);
    this.queries.next(query);
  }

  protected linkParams(match: SearchMatch | undefined): Record<string, string> {
    // Conversation matches open the session at the message.
    return match?.anchor ? { at: match.anchor, q: this.query().trim() } : {};
  }
}
