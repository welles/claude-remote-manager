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
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatRadioModule } from '@angular/material/radio';
import { RouterLink } from '@angular/router';
import type {
  CleanupAction,
  CleanupDirectory,
  CleanupOutcome,
  CleanupPreview,
  CleanupResult,
  DirectoryLoss,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { LossDetails } from './loss-details';
import { SessionsApi } from './sessions-api';

export type CleanupMode = 'cleanup' | 'archive';

/** Text of a choice for a directory. */
export function actionLabel(
  action: CleanupAction,
  directory: CleanupDirectory,
): string {
  switch (action) {
    case 'push':
      return directory.hasCommits
        ? `Push ${directory.branch} to the remote, then remove the clone`
        : 'Remove the clone (nothing to push)';
    case 'merge':
      return directory.hasCommits
        ? `Fast-forward ${directory.baseBranch ?? 'main'} of the project to the session branch, then remove the clone`
        : 'Remove the clone (nothing to merge)';
    case 'discard':
      return directory.kind === 'scratch'
        ? 'Remove the directory'
        : 'Remove the clone without pushing';
    case 'keep':
      return 'Keep it';
  }
}

/** What a choice would lose, as far as known before running it. */
export function lossOf(
  action: CleanupAction,
  directory: CleanupDirectory,
): DirectoryLoss | null {
  if (action === 'keep') {
    return null;
  }
  if ((action === 'push' || action === 'merge') && directory.hasCommits) {
    return directory.lossAfterIntegration ?? directory.loss;
  }
  return directory.loss;
}

/**
 * Cleans up a session's clones and scratch directory, or archives the
 * session with the same choices: per directory push (or fast-forward a
 * local project), discard or keep, with what each choice would lose read
 * fresh when the dialog opens. A choice that loses work needs an explicit
 * "accept" first. A native modal `<dialog>`, like the other dialogs.
 */
@Component({
  selector: 'app-cleanup-dialog',
  imports: [
    LossDetails,
    MatButtonModule,
    MatCheckboxModule,
    MatProgressBarModule,
    MatRadioModule,
    RouterLink,
  ],
  template: `
    <dialog
      #dialog
      class="dialog"
      aria-labelledby="cleanup-title"
      (close)="closed()"
      data-testid="cleanup-dialog"
    >
      @if (open()) {
        <h2 id="cleanup-title">
          {{ mode() === 'archive' ? 'Archive this session?' : 'Clean up' }}
        </h2>
        @if (outcomes(); as outcomes) {
          <ul class="outcomes" data-testid="cleanup-outcomes">
            @for (outcome of outcomes; track outcome.position) {
              <li [class.failed]="outcome.result === 'failed'">
                <strong>{{ outcome.name }}</strong
                >: {{ outcome.message }}
              </li>
            } @empty {
              <li>The session was archived; nothing was cleaned up.</li>
            }
          </ul>
          <div class="actions">
            <button matButton="filled" type="button" (click)="close()">
              Close
            </button>
          </div>
        } @else {
          @if (mode() === 'archive') {
            <p>
              Archiving ends the session and hides it from the list. Its history
              stays readable and searchable, and you can unarchive it later.
              Choose what happens to its directories now:
            </p>
          } @else {
            <p>Choose what happens to each directory of the session:</p>
          }
          @if (preview(); as preview) {
            @if (blockedReason(); as reason) {
              <p class="warning" role="alert">{{ reason }}.</p>
            }
            @if (hasClones()) {
              <a
                matButton
                [routerLink]="['/sessions', sessionId(), 'changes']"
                data-testid="review-changes"
                >Review the changes first</a
              >
            }
            @for (directory of preview.directories; track directory.position) {
              <fieldset class="directory" data-testid="cleanup-directory">
                <legend>
                  <strong>{{ directory.name }}</strong>
                  @if (directory.branch) {
                    <span class="muted"> · {{ directory.branch }}</span>
                  }
                </legend>
                <p class="muted path">{{ directory.path }}</p>
                @if (directory.error) {
                  <p class="warning">{{ directory.error }}</p>
                }
                <mat-radio-group
                  class="choices"
                  [value]="choice(directory)"
                  (change)="choose(directory, $event.value)"
                  [name]="'choice-' + directory.position"
                  [attr.aria-label]="'What happens to ' + directory.name"
                >
                  @for (action of directory.actions; track action) {
                    <mat-radio-button
                      [value]="action"
                      [attr.data-testid]="'choice-' + action"
                      >{{ actionLabel(action, directory) }}</mat-radio-button
                    >
                  }
                </mat-radio-group>
                @let loss = lossOf(choice(directory), directory);
                @if (choice(directory) !== 'keep') {
                  @if (loss) {
                    @if (!loss.clean) {
                      <p class="warning">
                        {{
                          choice(directory) === 'discard'
                            ? 'Removing it loses:'
                            : 'Still lost afterwards:'
                        }}
                      </p>
                    }
                    <app-loss-details
                      [loss]="loss"
                      [scratch]="directory.kind === 'scratch'"
                    />
                    @if (!loss.clean) {
                      <mat-checkbox
                        [checked]="accepted().has(directory.position)"
                        (change)="accept(directory, $event.checked)"
                        data-testid="accept-loss"
                        >Remove it anyway: I accept losing this</mat-checkbox
                      >
                    }
                  } @else {
                    <p class="warning">
                      What it holds is unknown, so it is kept.
                    </p>
                  }
                }
              </fieldset>
            } @empty {
              <p class="muted">The session has no directories left.</p>
            }
            @if (removes()) {
              <p class="note" data-testid="no-resume-note">
                Afterwards the session can still be read, but not continued.
              </p>
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
              type="button"
              [class.danger]="removes()"
              [disabled]="!ready() || busy()"
              (click)="confirm()"
              data-testid="cleanup-confirm"
            >
              {{ confirmLabel() }}
            </button>
          </div>
          @if (busy()) {
            <mat-progress-bar mode="indeterminate" />
          }
        }
      }
    </dialog>
  `,
  styles: `
    .dialog {
      /* Anchored at the top: the dialog grows downwards as choices change. */
      margin: 5vh auto auto;
      width: min(640px, calc(100vw - 32px));
      max-height: 90dvh;
      box-sizing: border-box;
      border: none;
      border-radius: 16px;
      padding: 16px 20px;
      background: var(--mat-sys-surface-container-high);
      color: var(--mat-sys-on-surface);
    }
    .dialog::backdrop {
      background: rgb(0 0 0 / 40%);
    }
    h2 {
      font: var(--mat-sys-headline-small);
      margin: 0 0 12px;
    }
    .directory {
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 12px;
      margin: 12px 0;
      padding: 8px 12px;
      min-width: 0;
    }
    /* A floated legend is a normal block inside the border, so a long
       name can wrap without the border line running through it. */
    legend {
      float: left;
      width: 100%;
      margin: 0 0 4px;
      padding: 0;
      overflow-wrap: anywhere;
    }
    legend + * {
      clear: left;
    }
    .choices {
      display: flex;
      flex-direction: column;
    }
    .path,
    .muted {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
      overflow-wrap: anywhere;
    }
    p {
      margin: 4px 0;
    }
    .warning,
    .failed {
      color: var(--mat-sys-error);
    }
    .note {
      font-weight: 500;
    }
    .outcomes {
      padding-left: 20px;
      overflow-wrap: anywhere;
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
export class CleanupDialog {
  private readonly api = inject(SessionsApi);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly sessionId = input.required<string>();
  /** Emitted after a cleanup or archiving ran. */
  readonly done = output<CleanupResult>();

  protected readonly actionLabel = actionLabel;
  protected readonly lossOf = lossOf;
  protected readonly open = signal(false);
  protected readonly mode = signal<CleanupMode>('cleanup');
  protected readonly preview = signal<CleanupPreview | null>(null);
  protected readonly choices = signal(new Map<number, CleanupAction>());
  protected readonly accepted = signal(new Set<number>());
  protected readonly outcomes = signal<CleanupOutcome[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly hasClones = computed(
    () =>
      this.preview()?.directories.some((entry) => entry.kind === 'clone') ??
      false,
  );
  /** Some choice removes a directory. */
  protected readonly removes = computed(() => {
    const preview = this.preview();
    return (
      !!preview &&
      preview.directories.some(
        (directory) =>
          this.choices().get(directory.position) !== undefined &&
          this.choices().get(directory.position) !== 'keep',
      )
    );
  });
  /** Why the chosen operation cannot run now. */
  protected readonly blockedReason = computed(() => {
    const preview = this.preview();
    return (
      (this.mode() === 'archive'
        ? preview?.archiveBlocked
        : preview?.blocked) ?? null
    );
  });
  /** Every choice that loses work was accepted. */
  protected readonly ready = computed(() => {
    const preview = this.preview();
    if (!preview || this.blockedReason()) {
      return false;
    }
    return preview.directories.every((directory) => {
      const action = this.choices().get(directory.position) ?? 'keep';
      const loss = lossOf(action, directory);
      return (
        action === 'keep' ||
        (loss !== null &&
          (loss.clean || this.accepted().has(directory.position)))
      );
    });
  });
  protected readonly confirmLabel = computed(() =>
    this.mode() === 'archive'
      ? 'Archive'
      : this.removes()
        ? 'Clean up'
        : 'Nothing to do',
  );

  /** Opens the dialog and reads what the directories hold. */
  show(mode: CleanupMode): void {
    this.mode.set(mode);
    this.open.set(true);
    this.preview.set(null);
    this.choices.set(new Map());
    this.accepted.set(new Set());
    this.outcomes.set(null);
    this.error.set(null);
    this.busy.set(false);
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    }
    this.api.cleanupPreview(this.sessionId()).subscribe({
      next: (preview) => this.preview.set(preview),
      error: (error: unknown) =>
        this.error.set(
          errorMessage(error, 'What the directories hold could not be read.'),
        ),
    });
  }

  protected choice(directory: CleanupDirectory): CleanupAction {
    return this.choices().get(directory.position) ?? 'keep';
  }

  protected choose(directory: CleanupDirectory, action: CleanupAction): void {
    this.choices.update((map) => new Map(map).set(directory.position, action));
  }

  protected accept(directory: CleanupDirectory, on: boolean): void {
    this.accepted.update((set) => {
      const next = new Set(set);
      if (on) {
        next.add(directory.position);
      } else {
        next.delete(directory.position);
      }
      return next;
    });
  }

  protected confirm(): void {
    const preview = this.preview();
    if (!preview) {
      return;
    }
    const choices = preview.directories
      .map((directory) => ({
        position: directory.position,
        action: this.choice(directory),
        acceptLoss: this.accepted().has(directory.position),
      }))
      .filter((choice) => choice.action !== 'keep');
    if (this.mode() === 'cleanup' && choices.length === 0) {
      this.close();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    const request =
      this.mode() === 'archive'
        ? this.api.archive(this.sessionId(), choices)
        : this.api.cleanup(this.sessionId(), choices);
    request.subscribe({
      next: (result) => {
        this.busy.set(false);
        this.outcomes.set(result.outcomes);
        this.done.emit(result);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(error, 'Nothing was changed.'));
      },
    });
  }

  protected closed(): void {
    this.open.set(false);
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
