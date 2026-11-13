import {
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type { DeletionPreview } from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { formatCost } from './format';
import { LossDetails } from './loss-details';
import { SessionsApi } from './sessions-api';

/**
 * Confirms deleting a session for good: lists what goes (its directories
 * with what they hold, the conversation, images, shown files) and what
 * stays (its usage in the statistics, pull requests on GitHub), read when
 * it opens.
 */
@Component({
  selector: 'app-delete-session-dialog',
  imports: [
    FormsModule,
    LossDetails,
    MatButtonModule,
    MatCheckboxModule,
    MatProgressBarModule,
  ],
  template: `
    <dialog
      #dialog
      class="dialog"
      aria-labelledby="delete-title"
      (close)="open.set(false)"
      data-testid="delete-dialog"
    >
      @if (open()) {
        <h2 id="delete-title">Delete this session for good?</h2>
        @if (preview(); as preview) {
          @if (preview.blocked) {
            <p class="warning" role="alert">{{ preview.blocked }}.</p>
          }
          <p>This cannot be undone. Deleted:</p>
          <ul>
            <li>
              the conversation{{
                preview.transcript ? " (Claude Code's transcript)" : ''
              }}
              and the session's history
            </li>
            @if (preview.attachments > 0) {
              <li>{{ preview.attachments }} attached image(s)</li>
            }
            @if (preview.shownFiles > 0) {
              <li>{{ preview.shownFiles }} file(s) Claude showed</li>
            }
            @for (directory of preview.directories; track directory.position) {
              <li>
                the
                {{
                  directory.kind === 'scratch'
                    ? 'scratch directory'
                    : 'clone of ' + directory.name
                }}
              </li>
            }
          </ul>
          @for (directory of preview.directories; track directory.position) {
            @if (directory.loss; as loss) {
              @if (!loss.clean) {
                <section class="loss" data-testid="delete-loss">
                  <h3>{{ directory.name }} holds work that is lost:</h3>
                  <app-loss-details
                    [loss]="loss"
                    [scratch]="directory.kind === 'scratch'"
                  />
                </section>
              }
            } @else {
              <p class="warning">
                What {{ directory.name }} holds could not be read{{
                  directory.error ? ': ' + directory.error : ''
                }}.
              </p>
            }
          }
          <p class="muted">{{ keptText(preview) }}</p>
          @if (dirty()) {
            <mat-checkbox
              [(ngModel)]="acceptLoss"
              data-testid="delete-accept-loss"
              >I accept losing the work listed above</mat-checkbox
            >
          }
        } @else if (!error()) {
          <mat-progress-bar mode="indeterminate" />
        }
        @if (error(); as text) {
          <p class="warning" role="alert">{{ text }}</p>
        }
        <div class="actions">
          <button matButton type="button" (click)="close()">Cancel</button>
          <button
            matButton="filled"
            class="danger"
            type="button"
            [disabled]="
              !preview() ||
              !!preview()?.blocked ||
              busy() ||
              (dirty() && !acceptLoss())
            "
            (click)="confirm()"
            data-testid="delete-confirm"
          >
            Delete session
          </button>
        </div>
      }
    </dialog>
  `,
  styles: `
    .dialog {
      margin: 5vh auto auto;
      width: min(560px, calc(100vw - 32px));
      max-height: 90dvh;
      box-sizing: border-box;
      border: none;
      border-radius: var(--mat-sys-corner-large);
      padding: 16px 20px;
      background: var(--mat-sys-surface-container-high);
      color: var(--mat-sys-on-surface);
    }
    .dialog::backdrop {
      background: var(--app-scrim);
    }
    h2 {
      font: var(--mat-sys-headline-small);
      margin: 0 0 12px;
    }
    h3 {
      font: var(--mat-sys-title-small);
      margin: 12px 0 4px;
      overflow-wrap: anywhere;
    }
    ul {
      padding-left: 20px;
      overflow-wrap: anywhere;
    }
    .muted {
      color: var(--mat-sys-on-surface-variant);
    }
    .warning {
      color: var(--mat-sys-error);
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
export class DeleteSessionDialog {
  private readonly api = inject(SessionsApi);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly sessionId = input.required<string>();
  /** Emitted after the session was deleted. */
  readonly deleted = output<string>();

  protected readonly formatCost = formatCost;
  protected readonly open = signal(false);
  protected readonly preview = signal<DeletionPreview | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly acceptLoss = signal(false);
  protected readonly dirty = computed(
    () =>
      this.preview()?.directories.some(
        (directory) => !directory.loss || !directory.loss.clean,
      ) ?? false,
  );

  /** What stays after deleting. */
  protected keptText(preview: DeletionPreview): string {
    const pulls =
      preview.pullRequests > 0
        ? `, and its ${preview.pullRequests} pull request(s) on GitHub`
        : '';
    return `Kept: its usage in the statistics (${formatCost(preview.usage.costUsd)} theoretical API cost), under its title and repositories${pulls}.`;
  }

  show(): void {
    this.open.set(true);
    this.preview.set(null);
    this.error.set(null);
    this.busy.set(false);
    this.acceptLoss.set(false);
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    }
    this.api.deletionPreview(this.sessionId()).subscribe({
      next: (preview) => this.preview.set(preview),
      error: (error: unknown) =>
        this.error.set(errorMessage(error, 'The session could not be read.')),
    });
  }

  protected confirm(): void {
    this.busy.set(true);
    this.error.set(null);
    this.api.delete(this.sessionId(), this.acceptLoss()).subscribe({
      next: () => {
        this.close();
        this.deleted.emit(this.sessionId());
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(error, 'The session was not deleted.'));
      },
    });
  }

  protected close(): void {
    const dialog = this.dialog().nativeElement;
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
    this.open.set(false);
  }
}
