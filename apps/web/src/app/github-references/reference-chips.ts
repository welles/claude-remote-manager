import { Component, input, output } from '@angular/core';
import type { DraftReferences } from './draft-references';
import { ReferenceChip } from './reference-chip';
import { repositoryName, type ReferenceOptions } from './references';

/**
 * The GitHub references of the text being written, as chips: title and
 * state from GitHub, a preview, and the choice to give Claude the comments
 * and (pull requests) the diff. A `#12` that several of the session's
 * repositories have asks which one is meant.
 */
@Component({
  selector: 'app-reference-chips',
  imports: [ReferenceChip],
  template: `
    @if (references().entries().length > 0) {
      <div class="chips" data-testid="draft-references">
        @for (entry of references().entries(); track entry.key) {
          @if (entry.kind === 'chip') {
            <app-reference-chip
              [chip]="entry.chip"
              [editable]="true"
              [showRepository]="showRepository()"
              (optionsChange)="
                optionsChange.emit({ key: entry.key, options: $event })
              "
            />
          } @else {
            <div
              class="ambiguous"
              role="group"
              [attr.aria-label]="
                '#' + entry.number + ' is in several repositories'
              "
              data-testid="ambiguous-reference"
            >
              <span class="question">#{{ entry.number }} in:</span>
              @for (candidate of entry.candidates; track candidate.repository) {
                <button
                  type="button"
                  class="candidate state-{{
                    candidate.detail.draft && candidate.detail.state === 'open'
                      ? 'draft'
                      : candidate.detail.state
                  }}"
                  [title]="
                    candidate.repository +
                    '#' +
                    entry.number +
                    ': ' +
                    candidate.detail.title
                  "
                  (click)="
                    repositoryChosen.emit({
                      number: entry.number,
                      repository: candidate.repository,
                    })
                  "
                  data-testid="reference-candidate"
                >
                  <span class="dot" aria-hidden="true"></span>
                  <span class="token"
                    >{{ name(candidate.repository) }}#{{ entry.number }}</span
                  >
                  <span class="title">{{ candidate.detail.title }}</span>
                </button>
              }
            </div>
          }
        }
      </div>
    }
  `,
  styles: `
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 6px;
      margin-bottom: 4px;
    }
    .ambiguous {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 6px;
      max-width: 100%;
      padding: 2px 6px;
      border: 1px dashed var(--mat-sys-tertiary);
      border-radius: var(--mat-sys-corner-medium);
    }
    .question {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-tertiary);
    }
    .candidate {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 18em;
      min-height: 28px;
      padding: 1px 8px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-medium);
      background: var(--mat-sys-surface-container-high);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-medium);
      cursor: pointer;
    }
    .dot {
      flex-shrink: 0;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--app-gh-draft);
    }
    .state-open .dot {
      background: var(--app-gh-open);
    }
    .state-merged .dot {
      background: var(--app-gh-merged);
    }
    .state-closed .dot {
      background: var(--app-gh-closed);
    }
    .token {
      flex-shrink: 0;
      font-weight: 500;
    }
    .title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
})
export class ReferenceChips {
  readonly references = input.required<DraftReferences>();
  /** Name the repository of `#12` (the session has several). */
  readonly showRepository = input(false);
  readonly optionsChange = output<{ key: string; options: ReferenceOptions }>();
  /** The user chose which repository a `#12` means. */
  readonly repositoryChosen = output<{ number: number; repository: string }>();

  protected readonly name = repositoryName;
}
