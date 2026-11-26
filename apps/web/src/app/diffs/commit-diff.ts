import { Component, effect, inject, input, signal } from '@angular/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import type {
  CommitDiffResponse,
  SessionDiffFile,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { SessionsApi } from '../sessions/sessions-api';
import { AppDatePipe } from '../ui/dates';
import { AppIcon } from '../ui/icon';
import { DiffFiles } from './diff-files';
import { DiffLayoutPreference } from './diff-layout';
import type { DiffLayout } from './diff-rows';

/**
 * One commit of a session clone on the changes page: its whole message,
 * author and date, and its diff against its parent (unified or side by
 * side, as the session diff).
 */
@Component({
  selector: 'app-commit-diff',
  imports: [AppDatePipe, AppIcon, DiffFiles, MatProgressBarModule, RouterLink],
  host: { class: 'flex min-w-0 flex-col gap-3' },
  template: `
    <div class="flex flex-wrap items-center gap-2">
      <a
        class="type-label-large text-primary"
        [routerLink]="[]"
        data-testid="all-changes"
        >All changes</a
      >
      <span class="flex-1"></span>
      <div
        class="inline-flex flex-wrap gap-1"
        role="group"
        aria-label="Diff layout"
      >
        <button
          type="button"
          class="chip"
          [attr.aria-pressed]="layout() === 'unified'"
          (click)="setLayout('unified')"
        >
          Unified
        </button>
        <button
          type="button"
          class="chip"
          [attr.aria-pressed]="layout() === 'split'"
          (click)="setLayout('split')"
        >
          Side by side
        </button>
      </div>
    </div>
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    @if (error(); as message) {
      <p class="text-error" data-testid="commit-error">{{ message }}</p>
    }
    @if (diff(); as d) {
      <section data-testid="commit-diff">
        <header class="flex flex-col gap-1">
          <h2 class="m-0 type-title-medium wrap-anywhere">
            {{ d.commit.subject || '(no message)' }}
          </h2>
          @if (d.commit.body) {
            <p
              class="m-0 wrap-anywhere whitespace-pre-wrap"
              data-testid="commit-body"
            >
              {{ d.commit.body }}
            </p>
          }
          <p
            class="m-0 flex flex-wrap items-center gap-x-1.5 text-on-surface-variant wrap-anywhere [--app-icon-size:16px]"
          >
            <app-icon name="commit" />
            <code>{{ d.commit.sha.slice(0, 12) }}</code>
            <span>· {{ d.repository }}</span>
            @if (d.branch) {
              <span
                >· <code>{{ d.branch }}</code></span
              >
            }
            <span
              >· {{ d.commit.authorName }},
              {{ d.commit.authoredAt | appDate }}</span
            >
          </p>
          <p class="m-0 text-on-surface-variant" data-testid="commit-summary">
            @if (d.parent) {
              Compared with its parent
              <code>{{ d.parent.slice(0, 12) }}</code>
              @if (d.commit.parents.length > 1) {
                (the first of {{ d.commit.parents.length }})
              }
            } @else {
              The first commit of the repository
            }
            · {{ d.fileCount }} {{ d.fileCount === 1 ? 'file' : 'files' }}
            changed,
            <span class="text-diff-add">+{{ d.commit.additions }}</span>
            <span class="text-diff-del">−{{ d.commit.deletions }}</span>
          </p>
        </header>
        @if (d.files.length === 0) {
          <p class="my-1 text-on-surface-variant">No changes.</p>
        } @else {
          <app-diff-files
            [files]="d.files"
            [fileCount]="d.fileCount"
            [layout]="layout()"
            idPrefix="commit-diff"
            [loader]="loadFile"
          />
        }
      </section>
    }
  `,
})
export class CommitDiff {
  private readonly api = inject(SessionsApi);
  private readonly preference = inject(DiffLayoutPreference);

  readonly sessionId = input.required<string>();
  readonly repositoryId = input.required<string>();
  readonly branch = input<string | null>(null);
  readonly sha = input.required<string>();

  protected readonly layout = this.preference.layout;
  protected readonly diff = signal<CommitDiffResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect((onCleanup) => {
      const [sessionId, repositoryId, branch, sha] = [
        this.sessionId(),
        this.repositoryId(),
        this.branch(),
        this.sha(),
      ];
      this.loading.set(true);
      this.error.set(null);
      this.diff.set(null);
      const subscription = this.api
        .commitDiff(sessionId, repositoryId, branch, sha)
        .subscribe({
          next: (diff) => {
            this.diff.set(diff);
            this.loading.set(false);
          },
          error: (error: unknown) => {
            this.error.set(
              errorMessage(error, 'The commit could not be loaded.'),
            );
            this.loading.set(false);
          },
        });
      onCleanup(() => subscription.unsubscribe());
    });
  }

  protected setLayout(layout: DiffLayout): void {
    this.preference.set(layout);
  }

  protected readonly loadFile = (file: SessionDiffFile) =>
    this.api.commitFileDiff(
      this.sessionId(),
      this.repositoryId(),
      this.branch(),
      this.sha(),
      file.path,
      file.oldPath,
    );
}
