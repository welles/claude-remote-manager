import { HttpClient } from '@angular/common/http';
import { Component, inject, signal, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import type {
  MissingDirectory,
  OrphanedDirectory,
  WorkspaceOrphansResponse,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { LossDetails } from '../sessions/loss-details';
import { AppIcon } from '../ui/icon';
import { AppPageBar } from '../ui/page-bar';
import { Toasts } from '../ui/toasts';

const KIND_LABELS: Record<OrphanedDirectory['kind'], string> = {
  clone: 'Clone without session',
  scratch: 'Scratch directory without session',
  directory: 'Other directory',
};

/**
 * Leftovers in the workspace: directories no session uses, with what they
 * hold, removable after confirmation; and directories sessions expect
 * that are gone. Lazy-loaded.
 */
@Component({
  selector: 'app-workspace-page',
  host: { class: 'app-page gap-2' },
  imports: [
    AppIcon,
    AppPageBar,
    FormsModule,
    LossDetails,
    MatButtonModule,
    MatCheckboxModule,
    MatProgressBarModule,
    RouterLink,
  ],
  template: `
    <app-page-bar heading="Workspace cleanup" back="/settings" />
    <p class="m-0 text-on-surface-variant">
      Directories under the workspace's <code>sessions/</code> and
      <code>scratch/</code> that no session uses (left by a crash, a deleted
      database, or made by hand), and directories sessions expect that are gone.
      Nothing outside these directories is ever touched.
    </p>
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    @if (error(); as text) {
      <p class="m-0 text-error" role="alert">{{ text }}</p>
    }
    @if (data(); as data) {
      <h2 class="app-section-label">Directories without session</h2>
      @for (orphan of data.orphans; track orphan.path) {
        <section
          class="flex flex-col items-start gap-1 rounded-md border border-outline-variant bg-surface-container-low p-3"
          data-testid="orphan"
        >
          <div class="flex flex-wrap gap-x-3 gap-y-1">
            <strong>{{ kindLabels[orphan.kind] }}</strong>
            @if (orphan.branch) {
              <span class="text-on-surface-variant">{{ orphan.branch }}</span>
            }
          </div>
          <code class="type-body-small wrap-anywhere">{{ orphan.path }}</code>
          @if (orphan.loss; as loss) {
            <app-loss-details
              class="self-stretch"
              [loss]="loss"
              [scratch]="orphan.kind !== 'clone'"
            />
          } @else {
            <p class="m-0 text-error">
              What it holds could not be read{{
                orphan.error ? ': ' + orphan.error : ''
              }}.
            </p>
          }
          @if (confirming() === orphan.path) {
            <div class="[&_p]:my-1">
              <p>Remove this directory for good? This cannot be undone.</p>
              @if (!orphan.loss?.clean) {
                <mat-checkbox
                  [(ngModel)]="acceptLoss"
                  data-testid="orphan-accept-loss"
                  >I accept losing what it holds</mat-checkbox
                >
              }
              <div class="flex gap-2">
                <button
                  matButton="filled"
                  class="app-danger"
                  type="button"
                  [disabled]="busy() || (!orphan.loss?.clean && !acceptLoss())"
                  (click)="remove(orphan)"
                  data-testid="orphan-remove-confirm"
                >
                  Remove
                </button>
                <button matButton type="button" (click)="confirming.set(null)">
                  Cancel
                </button>
              </div>
            </div>
          } @else {
            <button
              matButton
              type="button"
              (click)="askRemove(orphan)"
              data-testid="orphan-remove"
            >
              Remove…
            </button>
          }
        </section>
      } @empty {
        <p
          class="m-0 flex items-center gap-2 rounded-md border border-dashed border-outline-variant p-3 text-on-surface-variant [--app-icon-size:18px]"
          data-testid="no-orphans"
        >
          <app-icon name="check" />None: every directory belongs to a session.
        </p>
      }
      <h2 class="app-section-label">Directories that are gone</h2>
      @for (entry of data.missing; track entry.sessionId + entry.position) {
        <section
          class="flex flex-col items-start gap-1 rounded-md border border-outline-variant bg-surface-container-low p-3"
          data-testid="missing"
        >
          <div class="flex flex-wrap gap-x-3 gap-y-1">
            <strong>{{ entry.name }}</strong> of
            <a [routerLink]="['/sessions', entry.sessionId]">{{
              entry.sessionTitle || 'Untitled session'
            }}</a>
          </div>
          <code class="type-body-small wrap-anywhere">{{ entry.path }}</code>
          <p class="m-0 text-on-surface-variant">
            The session cannot be continued without it. Marking it removed makes
            the session say so.
          </p>
          <button
            matButton
            type="button"
            [disabled]="busy()"
            (click)="forget(entry)"
            data-testid="missing-forget"
          >
            Mark as removed
          </button>
        </section>
      } @empty {
        <p
          class="m-0 flex items-center gap-2 rounded-md border border-dashed border-outline-variant p-3 text-on-surface-variant [--app-icon-size:18px]"
          data-testid="no-missing"
        >
          <app-icon name="check" />None: every session has its directories.
        </p>
      }
    }
  `,
})
export class WorkspacePage implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toasts = inject(Toasts);

  protected readonly kindLabels = KIND_LABELS;
  protected readonly data = signal<WorkspaceOrphansResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly confirming = signal<string | null>(null);
  protected readonly acceptLoss = signal(false);

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.http
      .get<WorkspaceOrphansResponse>('/api/workspace/orphans')
      .subscribe({
        next: (data) => {
          this.loading.set(false);
          this.data.set(data);
        },
        error: (error: unknown) => {
          this.loading.set(false);
          this.error.set(
            errorMessage(error, 'The workspace could not be read.'),
          );
        },
      });
  }

  protected askRemove(orphan: OrphanedDirectory): void {
    this.acceptLoss.set(false);
    this.confirming.set(orphan.path);
  }

  protected remove(orphan: OrphanedDirectory): void {
    this.busy.set(true);
    this.error.set(null);
    this.http
      .post<WorkspaceOrphansResponse>('/api/workspace/orphans/remove', {
        path: orphan.path,
        confirm: true,
        acceptLoss: this.acceptLoss(),
      })
      .subscribe({
        next: (data) => {
          this.busy.set(false);
          this.confirming.set(null);
          this.data.set(data);
          this.toasts.show({
            title: 'Directory removed',
            lines: [orphan.path],
          });
        },
        error: (error: unknown) => {
          this.busy.set(false);
          this.error.set(errorMessage(error, 'The directory was not removed.'));
        },
      });
  }

  protected forget(entry: MissingDirectory): void {
    this.busy.set(true);
    this.http
      .post('/api/workspace/missing/forget', {
        sessionId: entry.sessionId,
        position: entry.position,
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.toasts.show({
            title: 'Marked as removed',
            lines: [
              `${entry.name} of ${entry.sessionTitle || 'Untitled session'}`,
            ],
          });
          this.load();
        },
        error: (error: unknown) => {
          this.busy.set(false);
          this.error.set(errorMessage(error, 'Nothing was changed.'));
        },
      });
  }
}
