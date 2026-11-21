import { Component, input } from '@angular/core';
import type { DirectoryLoss } from '@claude-remote-manager/shared-types';
import { formatBytes } from './format';

/**
 * What removing a directory would lose: uncommitted files (all files of a
 * scratch directory), commits not on the remote, stash entries.
 */
@Component({
  selector: 'app-loss-details',
  host: { class: 'block' },
  template: `
    @let loss = this.loss();
    @if (loss.clean) {
      <p class="my-1" data-testid="loss-clean">
        Nothing would be lost{{
          scratch()
            ? ': the directory is empty'
            : ': everything is on the remote'
        }}.
      </p>
    } @else {
      @if (loss.fileCount > 0) {
        <h4 class="mt-2 mb-1 type-title-small">
          {{ loss.fileCount }}
          {{ scratch() ? 'file' : 'uncommitted file'
          }}{{ loss.fileCount === 1 ? '' : 's' }}
        </h4>
        <ul
          class="m-0 max-h-[140px] overflow-auto pl-5 wrap-anywhere"
          data-testid="loss-files"
        >
          @for (file of loss.files; track file) {
            <li>
              <code>{{ file }}</code>
            </li>
          }
          @if (loss.fileCount > loss.files.length) {
            <li>… and {{ loss.fileCount - loss.files.length }} more</li>
          }
        </ul>
      }
      @if (loss.unpushedCount > 0) {
        <h4 class="mt-2 mb-1 type-title-small">
          {{ loss.unpushedCount }} commit{{
            loss.unpushedCount === 1 ? '' : 's'
          }}
          not on the remote
        </h4>
        <ul
          class="m-0 max-h-[140px] overflow-auto pl-5 wrap-anywhere"
          data-testid="loss-commits"
        >
          @for (commit of loss.unpushedCommits; track commit.sha) {
            <li>
              <code>{{ commit.sha.slice(0, 7) }}</code> {{ commit.subject }}
              <span class="type-body-small text-on-surface-variant"
                >({{ commit.branch }})</span
              >
            </li>
          }
          @if (loss.unpushedCount > loss.unpushedCommits.length) {
            <li>
              … and {{ loss.unpushedCount - loss.unpushedCommits.length }} more
            </li>
          }
        </ul>
      }
      @if (loss.stashes > 0) {
        <h4 class="mt-2 mb-1 type-title-small" data-testid="loss-stashes">
          {{ loss.stashes }} stash
          {{ loss.stashes === 1 ? 'entry' : 'entries' }}
        </h4>
      }
    }
    @if (loss.bytes !== null) {
      <p class="my-1 type-body-small text-on-surface-variant">
        {{ formatBytes(loss.bytes) }} on disk
      </p>
    }
  `,
})
export class LossDetails {
  readonly loss = input.required<DirectoryLoss>();
  /** A scratch directory: its files are all lost. */
  readonly scratch = input(false);
  protected readonly formatBytes = formatBytes;
}
