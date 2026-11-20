import {
  Component,
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
  RemoteBranch,
  RemoteBranchOutcome,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { LossDetails } from './loss-details';
import { AppDialog } from '../ui/dialog';
import { Toasts } from '../ui/toasts';
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

/** What deleting a remote branch means, in one line. */
export function remoteBranchState(branch: RemoteBranch): string {
  if (branch.error) {
    return `${branch.error}.`;
  }
  if (branch.blocked) {
    return `${branch.blocked}.`;
  }
  const unknown = branch.pullRequestsChecked
    ? ''
    : ' Open pull or merge requests could not be checked (no GitHub App).';
  if (branch.mergedBy !== null) {
    return `Merged by pull request #${branch.mergedBy}; deleting it loses nothing.`;
  }
  if (branch.unmergedCount === 0) {
    return `Its commits are on other branches too; deleting it loses nothing.${unknown}`;
  }
  return `${branch.unmergedCount} ${branch.unmergedCount === 1 ? 'commit is' : 'commits are'} on no other branch; deleting it loses ${branch.unmergedCount === 1 ? 'it' : 'them'}.${unknown}`;
}

/** The branch cannot be deleted at all (open pull request, check failed). */
const unavailable = (branch: RemoteBranch) =>
  !!branch.blocked || !!branch.error;

/**
 * Cleans up a session's clones and scratch directory, or archives the
 * session with the same choices: per directory push (or fast-forward a
 * local project), discard or keep, with what each choice would lose read
 * fresh when the dialog opens. A choice that loses work needs an explicit
 * "accept" first. The session's branches on the remotes can be deleted
 * too: checked when that loses nothing, never with an open pull request.
 * A native modal `<dialog>`, like the other dialogs.
 */
@Component({
  selector: 'app-cleanup-dialog',
  imports: [
    AppDialog,
    LossDetails,
    MatButtonModule,
    MatCheckboxModule,
    MatProgressBarModule,
    MatRadioModule,
    RouterLink,
  ],
  template: `
    <app-dialog
      class="wide"
      [heading]="mode() === 'archive' ? 'Archive this session?' : 'Clean up'"
      testId="cleanup-dialog"
      (closed)="closed()"
    >
      @if (open()) {
        <div>
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
            @if (preview.remoteBranches.length > 0) {
              <h3 class="section">Branches on the remote</h3>
              @for (branch of preview.remoteBranches; track branch.position) {
                <fieldset class="directory" data-testid="remote-branch">
                  <legend>
                    <strong>{{ branch.name }}</strong>
                    <span class="muted"> · {{ branch.branch }}</span>
                  </legend>
                  <p
                    [class.warning]="!branch.safe"
                    [id]="'remote-branch-state-' + branch.position"
                  >
                    {{ remoteBranchState(branch) }}
                  </p>
                  @if (pushes(branch.position)) {
                    <p class="muted">It is pushed in this cleanup; kept.</p>
                  }
                  <mat-checkbox
                    [checked]="deletesBranch(branch)"
                    [disabled]="unavailable(branch) || pushes(branch.position)"
                    [aria-describedby]="
                      'remote-branch-state-' + branch.position
                    "
                    (change)="chooseBranch(branch, $event.checked)"
                    data-testid="delete-remote-branch"
                    >Delete {{ branch.branch }} on the remote</mat-checkbox
                  >
                  @if (deletesBranch(branch) && branch.unmergedCount > 0) {
                    <mat-checkbox
                      [checked]="branchAccepted().has(branch.position)"
                      (change)="acceptBranch(branch, $event.checked)"
                      data-testid="accept-branch-loss"
                      >Delete it anyway: I accept losing these
                      commits</mat-checkbox
                    >
                  }
                </fieldset>
              }
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
          @if (busy()) {
            <mat-progress-bar mode="indeterminate" />
          }
        </div>
      }
      @if (open()) {
        <div dialog-actions>
          <button matButton type="button" (click)="close()">Cancel</button>
          <button
            matButton="filled"
            type="button"
            [class.app-danger]="removes() || losesCommits()"
            [disabled]="!ready() || busy()"
            (click)="confirm()"
            data-testid="cleanup-confirm"
          >
            {{ confirmLabel() }}
          </button>
        </div>
      }
    </app-dialog>
  `,
  styles: `
    .directory {
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-medium);
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
    .warning {
      color: var(--mat-sys-error);
    }
    .note {
      font-weight: 500;
    }
    .section {
      font: var(--mat-sys-title-small);
      margin: 16px 0 0;
    }
  `,
})
export class CleanupDialog {
  private readonly api = inject(SessionsApi);
  private readonly toasts = inject(Toasts);
  private readonly dialog = viewChild.required(AppDialog);

  readonly sessionId = input.required<string>();
  /** Emitted after a cleanup or archiving ran. */
  readonly done = output<CleanupResult>();
  /** Emitted after the session was archived (after `done`). */
  readonly archived = output<void>();

  protected readonly actionLabel = actionLabel;
  protected readonly lossOf = lossOf;
  protected readonly remoteBranchState = remoteBranchState;
  protected readonly unavailable = unavailable;
  protected readonly open = signal(false);
  protected readonly mode = signal<CleanupMode>('cleanup');
  protected readonly preview = signal<CleanupPreview | null>(null);
  protected readonly choices = signal(new Map<number, CleanupAction>());
  protected readonly accepted = signal(new Set<number>());
  /** Remote branches to delete, by position. */
  protected readonly branches = signal(new Set<number>());
  /** Remote branches whose lost commits were accepted. */
  protected readonly branchAccepted = signal(new Set<number>());
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  /** Counts the openings, so that a late answer finds a newer one. */
  private run = 0;

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
  /** The remote branches the cleanup deletes (not blocked or pushed). */
  protected readonly chosenBranches = computed(
    () =>
      this.preview()?.remoteBranches.filter((branch) =>
        this.deletesBranch(branch),
      ) ?? [],
  );
  /** A chosen branch deletion loses commits. */
  protected readonly losesCommits = computed(() =>
    this.chosenBranches().some((branch) => branch.unmergedCount > 0),
  );
  protected readonly deletesBranches = computed(
    () => this.chosenBranches().length > 0,
  );
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
    return (
      preview.directories.every((directory) => {
        const action = this.choices().get(directory.position) ?? 'keep';
        const loss = lossOf(action, directory);
        return (
          action === 'keep' ||
          (loss !== null &&
            (loss.clean || this.accepted().has(directory.position)))
        );
      }) &&
      this.chosenBranches().every(
        (branch) =>
          branch.unmergedCount === 0 ||
          this.branchAccepted().has(branch.position),
      )
    );
  });
  protected readonly confirmLabel = computed(() =>
    this.mode() === 'archive'
      ? 'Archive'
      : this.removes() || this.deletesBranches()
        ? 'Clean up'
        : 'Nothing to do',
  );

  /** Opens the dialog and reads what the directories hold. */
  show(mode: CleanupMode): void {
    this.run++;
    this.mode.set(mode);
    this.open.set(true);
    this.preview.set(null);
    this.choices.set(new Map());
    this.accepted.set(new Set());
    this.branches.set(new Set());
    this.branchAccepted.set(new Set());
    this.error.set(null);
    this.busy.set(false);
    this.dialog().open();
    const run = this.run;
    this.api.cleanupPreview(this.sessionId()).subscribe({
      next: (preview) => {
        if (run !== this.run) {
          return;
        }
        const remoteBranches = preview.remoteBranches ?? [];
        this.preview.set({ ...preview, remoteBranches });
        // Deleting what loses nothing is the default.
        this.branches.set(
          new Set(
            remoteBranches
              .filter((branch) => branch.safe)
              .map((branch) => branch.position),
          ),
        );
      },
      error: (error: unknown) => {
        if (run === this.run) {
          this.error.set(
            errorMessage(error, 'What the directories hold could not be read.'),
          );
        }
      },
    });
  }

  protected choice(directory: CleanupDirectory): CleanupAction {
    return this.choices().get(directory.position) ?? 'keep';
  }

  protected choose(directory: CleanupDirectory, action: CleanupAction): void {
    this.choices.update((map) => new Map(map).set(directory.position, action));
  }

  /** The directory at this position is pushed in this cleanup. */
  protected pushes(position: number): boolean {
    return this.choices().get(position) === 'push';
  }

  protected deletesBranch(branch: RemoteBranch): boolean {
    return (
      this.branches().has(branch.position) &&
      !unavailable(branch) &&
      !this.pushes(branch.position)
    );
  }

  protected chooseBranch(branch: RemoteBranch, on: boolean): void {
    this.branches.update((set) => toggled(set, branch.position, on));
  }

  protected acceptBranch(branch: RemoteBranch, on: boolean): void {
    this.branchAccepted.update((set) => toggled(set, branch.position, on));
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
    const branches = this.chosenBranches().map((branch) => ({
      position: branch.position,
      acceptLoss: this.branchAccepted().has(branch.position),
    }));
    if (
      this.mode() === 'cleanup' &&
      choices.length === 0 &&
      branches.length === 0
    ) {
      this.close();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    const mode = this.mode();
    // The dialog may be closed (Esc) or opened again meanwhile: then the
    // answer goes to a toast only.
    const run = this.run;
    const current = () => run === this.run && this.open();
    const request =
      mode === 'archive'
        ? this.api.archive(this.sessionId(), choices, branches)
        : this.api.cleanup(this.sessionId(), choices, branches);
    request.subscribe({
      next: (result) => {
        if (current()) {
          this.busy.set(false);
          this.close();
        }
        this.report(mode, result.outcomes, result.remoteBranches ?? []);
        this.done.emit(result);
        if (mode === 'archive') {
          this.archived.emit();
        }
      },
      error: (error: unknown) => {
        const message = errorMessage(error, 'Nothing was changed.');
        if (current()) {
          this.busy.set(false);
          this.error.set(message);
        } else {
          this.toasts.show({
            title:
              mode === 'archive'
                ? 'The session was not archived'
                : 'The cleanup failed',
            lines: [message],
            kind: 'error',
          });
        }
      },
    });
  }

  /** What happened, as a toast: it needs nothing from the user. */
  private report(
    mode: CleanupMode,
    outcomes: CleanupOutcome[],
    branches: RemoteBranchOutcome[],
  ): void {
    const archive = mode === 'archive';
    const all = [...outcomes, ...branches];
    const failed = all.some((outcome) => outcome.result === 'failed');
    this.toasts.show({
      title: archive
        ? failed
          ? 'Session archived; the cleanup failed in part'
          : 'Session archived'
        : failed
          ? 'The cleanup failed in part'
          : 'Cleaned up',
      lines:
        all.length > 0
          ? all.map(
              (outcome) =>
                `${outcome.result === 'failed' ? 'Failed: ' : ''}${outcome.name}: ${outcome.message}`,
            )
          : archive
            ? ['Nothing was cleaned up.']
            : [],
      kind: failed ? 'error' : 'info',
    });
  }

  protected closed(): void {
    this.open.set(false);
  }

  protected close(): void {
    this.dialog().close();
    this.open.set(false);
  }
}

function toggled(set: Set<number>, value: number, on: boolean): Set<number> {
  const next = new Set(set);
  if (on) {
    next.add(value);
  } else {
    next.delete(value);
  }
  return next;
}
