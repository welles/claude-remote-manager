import {
  Component,
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
import { AppDialog } from '../ui/dialog';
import { LossDetails } from './loss-details';
import { SessionsApi } from './sessions-api';
import { Toasts } from '../ui/toasts';

/**
 * Confirms deleting a session for good: lists what goes (its directories
 * with what they hold, the conversation, images, shown files) and what
 * stays (its usage in the statistics, pull requests on GitHub), read when
 * it opens.
 */
@Component({
  selector: 'app-delete-session-dialog',
  imports: [
    AppDialog,
    FormsModule,
    LossDetails,
    MatButtonModule,
    MatCheckboxModule,
    MatProgressBarModule,
  ],
  template: `
    <app-dialog
      heading="Delete this session for good?"
      testId="delete-dialog"
      (closed)="open.set(false)"
    >
      @if (open()) {
        <div>
          @if (preview(); as preview) {
            @if (preview.blocked) {
              <p class="text-error" role="alert">{{ preview.blocked }}.</p>
            }
            <p>This cannot be undone. Deleted:</p>
            <ul class="pl-5 wrap-anywhere">
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
              @for (
                directory of preview.directories;
                track directory.position
              ) {
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
                  <section data-testid="delete-loss">
                    <h3 class="mt-3 mb-1 type-title-small wrap-anywhere">
                      {{ directory.name }} holds work that is lost:
                    </h3>
                    <app-loss-details
                      [loss]="loss"
                      [scratch]="directory.kind === 'scratch'"
                    />
                  </section>
                }
              } @else {
                <p class="text-error">
                  What {{ directory.name }} holds could not be read{{
                    directory.error ? ': ' + directory.error : ''
                  }}.
                </p>
              }
            }
            <p class="text-on-surface-variant">{{ keptText(preview) }}</p>
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
            <p class="text-error" role="alert">{{ text }}</p>
          }
        </div>
      }
      @if (open()) {
        <div dialog-actions>
          <button matButton type="button" (click)="close()">Cancel</button>
          <button
            matButton="filled"
            class="app-danger"
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
    </app-dialog>
  `,
})
export class DeleteSessionDialog {
  private readonly api = inject(SessionsApi);
  private readonly toasts = inject(Toasts);
  private readonly dialog = viewChild.required(AppDialog);

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
    this.dialog().open();
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
        this.toasts.show({ title: 'Session deleted' });
        this.deleted.emit(this.sessionId());
      },
      error: (error: unknown) => {
        const message = errorMessage(error, 'The session was not deleted.');
        if (this.open()) {
          this.busy.set(false);
          this.error.set(message);
        } else {
          // Closed meanwhile (Esc): the error must not get lost.
          this.toasts.show({ title: message, kind: 'error' });
        }
      },
    });
  }

  protected close(): void {
    this.dialog().close();
    this.open.set(false);
  }
}
