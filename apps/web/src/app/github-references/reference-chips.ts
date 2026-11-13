import { Component, computed, inject, input, output } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { debounceTime } from 'rxjs';
import { referenceKey } from '@claude-remote-manager/shared-types';
import { ReferenceChip } from './reference-chip';
import {
  draftChip,
  draftReferences,
  ReferenceDetails,
  type ReferenceOptions,
} from './references';

/**
 * The GitHub references of the text being written, as chips: title and
 * state from GitHub, a preview, and the choice to give Claude the comments
 * and (pull requests) the diff.
 */
@Component({
  selector: 'app-reference-chips',
  imports: [ReferenceChip],
  template: `
    @if (chips().length > 0) {
      <div class="chips" data-testid="draft-references">
        @for (entry of chips(); track entry.key) {
          <app-reference-chip
            [chip]="entry.chip"
            [editable]="true"
            (optionsChange)="
              optionsChange.emit({ key: entry.key, options: $event })
            "
          />
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
  `,
})
export class ReferenceChips {
  readonly text = input.required<string>();
  /** GitHub repositories, the main one (for `#12`) first. */
  readonly repositories = input.required<string[]>();
  readonly options = input.required<ReadonlyMap<string, ReferenceOptions>>();
  readonly optionsChange = output<{ key: string; options: ReferenceOptions }>();

  private readonly details = inject(ReferenceDetails);
  /** The text once typing paused, so partial numbers are not looked up. */
  private readonly settled = toSignal(
    toObservable(this.text).pipe(debounceTime(400)),
    { initialValue: '' },
  );
  protected readonly chips = computed(() =>
    draftReferences(this.settled(), this.repositories(), this.options()).map(
      (request) => ({
        key: referenceKey(request.repository, request.number),
        chip: draftChip(
          request,
          this.details.get(request.repository, request.number)(),
        ),
      }),
    ),
  );
}
