import {
  Component,
  ElementRef,
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
import { SessionsApi } from './sessions-api';

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
  imports: [MatButtonModule, MatProgressBarModule],
  template: `
    <dialog
      #dialog
      class="dialog"
      aria-labelledby="discard-clone-title"
      (close)="closed()"
      data-testid="discard-clone-dialog"
    >
      @if (target(); as target) {
        <h2 id="discard-clone-title">Delete the clone of {{ target.name }}?</h2>
        @if (loss(); as loss) {
          @if (loss.clean) {
            <p>Nothing would be lost: everything in this clone is on GitHub.</p>
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
                    {{ loss.unpushedCount - loss.unpushedCommits.length }} more
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
        <div class="actions">
          <button matButton type="button" (click)="cancel()">Cancel</button>
          <button
            matButton="filled"
            class="danger"
            type="button"
            [disabled]="!loss() || busy()"
            (click)="discard(target)"
            data-testid="discard-clone-confirm"
          >
            Delete clone
          </button>
        </div>
      }
    </dialog>
  `,
  styles: `
    .dialog {
      max-width: min(560px, calc(100vw - 32px));
      border: none;
      border-radius: var(--mat-sys-corner-large);
      padding: 16px 24px;
      background: var(--mat-sys-surface-container-high);
      color: var(--mat-sys-on-surface);
    }
    .dialog::backdrop {
      background: var(--app-scrim);
    }
    h2 {
      font: var(--mat-sys-headline-small);
      margin: 0 0 12px;
      overflow-wrap: anywhere;
    }
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
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }
    .danger {
      --mat-button-filled-container-color: var(--mat-sys-error);
      --mat-button-filled-label-text-color: var(--mat-sys-on-error);
    }
  `,
})
export class DiscardCloneDialog {
  private readonly api = inject(SessionsApi);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

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
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) {
      // `showModal` is missing in old browsers and test DOMs.
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    }
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
        this.discarded.emit(target.repositoryId);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(error, 'The clone was not deleted.'));
      },
    });
  }

  private close(): void {
    const dialog = this.dialog().nativeElement;
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
    this.target.set(null);
  }
}
