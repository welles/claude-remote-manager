import { Component, input, output } from '@angular/core';
import type { GitHubReferenceSummary } from '@claude-remote-manager/shared-types';
import type { ReferenceAutocomplete } from './reference-autocomplete';

/** The `#` suggestions of a text field (see {@link ReferenceAutocomplete}). */
@Component({
  selector: 'app-reference-suggestions',
  template: `
    @if (autocomplete().open()) {
      <ul
        class="suggestions"
        [class.below]="below()"
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
            [class.active]="i === autocomplete().active()"
            [attr.aria-selected]="i === autocomplete().active()"
            (mousedown)="$event.preventDefault(); chosen.emit(item)"
            data-testid="reference-suggestion"
          >
            <span
              class="dot state-{{
                item.draft && item.state === 'open' ? 'draft' : item.state
              }}"
              [title]="item.state"
            ></span>
            <span class="number">#{{ item.number }}</span>
            <span class="title">{{ item.title }}</span>
            @if (showRepository()) {
              <span class="repository">{{ item.repository }}</span>
            }
            <span class="kind">{{
              item.kind === 'pull_request' ? 'PR' : 'Issue'
            }}</span>
          </li>
        }
        @for (error of autocomplete().errors(); track error) {
          <li class="error" data-testid="reference-search-error">
            {{ error }}
          </li>
        }
      </ul>
    }
  `,
  styles: `
    .suggestions {
      position: absolute;
      bottom: 100%;
      left: 0;
      right: 0;
      z-index: 2;
      max-height: 40vh;
      overflow-y: auto;
      margin: 0 0 4px;
      padding: 4px 0;
      list-style: none;
      border-radius: 8px;
      background: var(--mat-sys-surface-container-high);
      box-shadow: var(--mat-sys-level2);
    }
    .below {
      top: 100%;
      bottom: auto;
      margin: 4px 0 0;
    }
    li {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 36px;
      padding: 4px 12px;
      cursor: pointer;
    }
    .active {
      background: var(--mat-sys-secondary-container);
    }
    .dot {
      flex-shrink: 0;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #6b7280;
    }
    .state-open {
      background: #1a7f37;
    }
    .state-merged {
      background: #8250df;
    }
    .state-closed {
      background: #cf222e;
    }
    .number {
      flex-shrink: 0;
      font-weight: 500;
    }
    .title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .repository,
    .kind {
      flex-shrink: 0;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .error {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-error);
      cursor: default;
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
