import {
  Component,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type { CloneLossReport } from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { AppDialog } from '../ui/dialog';
import { SessionsApi } from './sessions-api';
import { Toasts } from '../ui/toasts';

/** A clone the user may delete. */
export interface DiscardCloneTarget {
  repositoryId: string;
  name: string;
}

/**
 * Confirms deleting a clone that autoclose kept: shows what would be lost
 * (uncommitted files, unpushed commits, stash entries, read fresh from the
 * clone when it opens) before anything is deleted. A native modal
 * `<dialog>` (focus and the inert page come from the browser), so the
 * app's start bundle stays without Material's dialog.
 */
@Component({
  selector: 'app-discard-clone-dialog',
  imports: [AppDialog, MatButtonModule, MatProgressBarModule],
  template: `
    <app-dialog
      [heading]="'Delete the clone of ' + (target()?.name ?? '') + '?'"
      testId="discard-clone-dialog"
      (closed)="closed()"
    >
      @if (target()) {
        <div>
          @if (loss(); as loss) {
            @if (loss.clean) {
              <p>
                Nothing would be lost: everything in this clone is on GitHub.
              </p>
            } @else {
              <p class="warning">
                This permanently deletes work that exists only in this clone. It
                cannot be undone.
              </p>
              @if (loss.uncommittedCount > 0) {
                <h3>{{ loss.uncommittedCount }} uncommitted file(s)</h3>
                <ul data-testid="loss-files">
                  @for (file of loss.uncommittedFiles; track file) {
                    <li>
                      <code>{{ file }}</code>
                    </li>
                  }
                  @if (loss.uncommittedCount > loss.uncommittedFiles.length) {
                    <li>
                      … and
                      {{ loss.uncommittedCount - loss.uncommittedFiles.length }}
                      more
                    </li>
                  }
                </ul>
              }
              @if (loss.unpushedCount > 0) {
                <h3>{{ loss.unpushedCount }} commit(s) not on GitHub</h3>
                <ul data-testid="loss-commits">
                  @for (commit of loss.unpushedCommits; track commit.sha) {
                    <li>
                      <code>{{ commit.sha.slice(0, 7) }}</code>
                      {{ commit.subject }}
                      <span class="muted">({{ commit.branch }})</span>
                    </li>
                  }
                  @if (loss.unpushedCount > loss.unpushedCommits.length) {
                    <li>
                      … and
                      {{ loss.unpushedCount - loss.unpushedCommits.length }}
                      more
                    </li>
                  }
                </ul>
              }
              @if (loss.stashes > 0) {
                <h3 data-testid="loss-stashes">
                  {{ loss.stashes }} stash
                  {{ loss.stashes === 1 ? 'entry' : 'entries' }}
                </h3>
              }
            }
            <p class="muted">{{ loss.path }}</p>
          } @else if (!error()) {
            <mat-progress-bar mode="indeterminate" />
          }
          @if (error(); as text) {
            <p class="warning" role="alert">{{ text }}</p>
          }
        </div>
      }
      @if (target(); as target) {
        <div dialog-actions>
          <button matButton type="button" (click)="cancel()">Cancel</button>
          <button
            matButton="filled"
            class="app-danger"
            type="button"
            [disabled]="!loss() || busy()"
            (click)="discard(target)"
            data-testid="discard-clone-confirm"
          >
            Delete clone
          </button>
        </div>
      }
    </app-dialog>
  `,
  styles: `
    h3 {
      font: var(--mat-sys-title-small);
      margin: 12px 0 4px;
    }
    ul {
      margin: 0;
      padding-left: 20px;
      max-height: 160px;
      overflow: auto;
      overflow-wrap: anywhere;
    }
    .muted {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
      overflow-wrap: anywhere;
    }
    .warning {
      color: var(--mat-sys-error);
      font-weight: 500;
    }
  `,
})
export class DiscardCloneDialog {
  private readonly api = inject(SessionsApi);
  private readonly toasts = inject(Toasts);
  private readonly dialog = viewChild.required(AppDialog);

  readonly sessionId = input.required<string>();
  /** Emitted after the clone was deleted. */
  readonly discarded = output<string>();

  protected readonly target = signal<DiscardCloneTarget | null>(null);
  protected readonly loss = signal<CloneLossReport | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  /** Opens the dialog for a clone and reads what it holds. */
  open(target: DiscardCloneTarget): void {
    this.target.set(target);
    this.loss.set(null);
    this.error.set(null);
    this.busy.set(false);
    this.dialog().open();
    this.api.cloneLoss(this.sessionId(), target.repositoryId).subscribe({
      next: (loss) => {
        if (this.target() === target) {
          this.loss.set(loss);
        }
      },
      error: (error: unknown) =>
        this.error.set(
          errorMessage(error, 'What the clone holds could not be read.'),
        ),
    });
  }

  protected cancel(): void {
    this.close();
  }

  protected closed(): void {
    this.target.set(null);
  }

  protected discard(target: DiscardCloneTarget): void {
    this.busy.set(true);
    this.error.set(null);
    this.api.discardClone(this.sessionId(), target.repositoryId).subscribe({
      next: () => {
        this.close();
        this.toasts.show({ title: `Clone of ${target.name} deleted` });
        this.discarded.emit(target.repositoryId);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(error, 'The clone was not deleted.'));
      },
    });
  }

  private close(): void {
    this.dialog().close();
    this.target.set(null);
  }
}
