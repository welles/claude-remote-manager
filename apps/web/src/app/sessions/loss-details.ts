import { Component, input } from '@angular/core';
import type { DirectoryLoss } from '@claude-remote-manager/shared-types';
import { formatBytes } from './format';

/**
 * What removing a directory would lose: uncommitted files (all files of a
 * scratch directory), commits not on the remote, stash entries.
 */
@Component({
  selector: 'app-loss-details',
  template: `
    @let loss = this.loss();
    @if (loss.clean) {
      <p class="clean" data-testid="loss-clean">
        Nothing would be lost{{
          scratch()
            ? ': the directory is empty'
            : ': everything is on the remote'
        }}.
      </p>
    } @else {
      @if (loss.fileCount > 0) {
        <h4>
          {{ loss.fileCount }}
          {{ scratch() ? 'file' : 'uncommitted file'
          }}{{ loss.fileCount === 1 ? '' : 's' }}
        </h4>
        <ul data-testid="loss-files">
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
        <h4>
          {{ loss.unpushedCount }} commit{{
            loss.unpushedCount === 1 ? '' : 's'
          }}
          not on the remote
        </h4>
        <ul data-testid="loss-commits">
          @for (commit of loss.unpushedCommits; track commit.sha) {
            <li>
              <code>{{ commit.sha.slice(0, 7) }}</code> {{ commit.subject }}
              <span class="muted">({{ commit.branch }})</span>
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
        <h4 data-testid="loss-stashes">
          {{ loss.stashes }} stash
          {{ loss.stashes === 1 ? 'entry' : 'entries' }}
        </h4>
      }
    }
    @if (loss.bytes !== null) {
      <p class="muted">{{ formatBytes(loss.bytes) }} on disk</p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    h4 {
      font: var(--mat-sys-title-small);
      margin: 8px 0 4px;
    }
    ul {
      margin: 0;
      padding-left: 20px;
      max-height: 140px;
      overflow: auto;
      overflow-wrap: anywhere;
    }
    p {
      margin: 4px 0;
    }
    .muted {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }
  `,
})
export class LossDetails {
  readonly loss = input.required<DirectoryLoss>();
  /** A scratch directory: its files are all lost. */
  readonly scratch = input(false);
  protected readonly formatBytes = formatBytes;
}
