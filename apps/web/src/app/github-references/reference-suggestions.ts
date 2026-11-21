import { Component, input, output } from '@angular/core';
import type { GitHubReferenceSummary } from '@claude-remote-manager/shared-types';
import type { ReferenceAutocomplete } from './reference-autocomplete';

/** The `#` suggestions of a text field (see {@link ReferenceAutocomplete}). */
@Component({
  selector: 'app-reference-suggestions',
  template: `
    @if (autocomplete().open()) {
      <ul
        class="suggest-list"
        [class.suggest-below]="below()"
        role="listbox"
        aria-label="Issues and pull requests"
        data-testid="reference-suggestions"
      >
        @for (
          item of autocomplete().suggestions();
          track item.repository + item.number;
          let i = $index
        ) {
          <li
            role="option"
            [attr.aria-selected]="i === autocomplete().active()"
            (mousedown)="$event.preventDefault(); chosen.emit(item)"
            data-testid="reference-suggestion"
          >
            <span
              class="state-dot tone-{{
                item.draft && item.state === 'open' ? 'draft' : item.state
              }}"
              [title]="item.state"
            ></span>
            <span class="flex-none font-medium">#{{ item.number }}</span>
            <span class="min-w-0 flex-1 truncate">{{ item.title }}</span>
            @if (showRepository()) {
              <span class="flex-none type-body-small text-on-surface-variant">{{
                item.repository
              }}</span>
            }
            <span class="flex-none type-body-small text-on-surface-variant">{{
              item.kind === 'pull_request' ? 'PR' : 'Issue'
            }}</span>
          </li>
        }
        @for (error of autocomplete().errors(); track error) {
          <li
            class="cursor-default! type-body-small text-error"
            data-testid="reference-search-error"
          >
            {{ error }}
          </li>
        }
      </ul>
    }
  `,
})
export class ReferenceSuggestions {
  readonly autocomplete = input.required<ReferenceAutocomplete>();
  /** Name the repository (several repositories are searched). */
  readonly showRepository = input(false);
  /** Open below the field instead of above. */
  readonly below = input(false);
  readonly chosen = output<GitHubReferenceSummary>();
}
