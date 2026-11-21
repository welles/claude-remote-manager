import { Component, input, output } from '@angular/core';
import type { GitHubReferenceDetail } from '@claude-remote-manager/shared-types';
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
      <div
        class="mb-1 flex flex-wrap gap-x-1.5 gap-y-1"
        data-testid="draft-references"
      >
        @for (entry of references().entries(); track entry.key) {
          @if (entry.kind === 'chip') {
            <app-reference-chip
              [chip]="entry.chip"
              [editable]="!entry.pending"
              [showRepository]="showRepository() && !entry.pending"
              (optionsChange)="
                optionsChange.emit({ key: entry.key, options: $event })
              "
            />
          } @else {
            <div
              class="flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md border border-dashed border-tertiary px-1.5 py-0.5"
              role="group"
              [attr.aria-label]="
                '#' + entry.number + ' is in several repositories'
              "
              data-testid="ambiguous-reference"
            >
              <span class="type-body-small text-tertiary"
                >#{{ entry.number }} in:</span
              >
              @for (candidate of entry.candidates; track candidate.repository) {
                <button
                  type="button"
                  class="ref-chip max-w-[18em] min-h-7 pointer-coarse:min-h-10"
                  [title]="
                    candidate.repository +
                    '#' +
                    entry.number +
                    ': ' +
                    candidate.detail.title +
                    ' (' +
                    stateOf(candidate.detail) +
                    ')'
                  "
                  [attr.aria-label]="
                    'Use ' +
                    candidate.repository +
                    '#' +
                    entry.number +
                    ': ' +
                    candidate.detail.title +
                    ' (' +
                    stateOf(candidate.detail) +
                    ')'
                  "
                  (click)="
                    repositoryChosen.emit({
                      number: entry.number,
                      repository: candidate.repository,
                    })
                  "
                  data-testid="reference-candidate"
                >
                  <span
                    class="state-dot tone-{{
                      candidate.detail.draft &&
                      candidate.detail.state === 'open'
                        ? 'draft'
                        : candidate.detail.state
                    }}"
                    aria-hidden="true"
                  ></span>
                  <span class="flex-none font-medium"
                    >{{ name(candidate.repository) }}#{{ entry.number }}</span
                  >
                  <span class="min-w-0 truncate">{{
                    candidate.detail.title
                  }}</span>
                  <span
                    class="flex-none type-body-small text-on-surface-variant"
                    >{{ stateOf(candidate.detail) }}</span
                  >
                </button>
              }
            </div>
          }
        }
      </div>
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

  /** `open`, `draft`, `merged` or `closed`. */
  protected stateOf(detail: GitHubReferenceDetail): string {
    return detail.draft && detail.state === 'open' ? 'draft' : detail.state;
  }
}
