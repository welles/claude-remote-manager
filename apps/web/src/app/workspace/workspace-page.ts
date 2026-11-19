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
  host: { class: 'app-page' },
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
    <p class="muted">
      Directories under the workspace's <code>sessions/</code> and
      <code>scratch/</code> that no session uses (left by a crash, a deleted
      database, or made by hand), and directories sessions expect that are gone.
      Nothing outside these directories is ever touched.
    </p>
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    @if (error(); as text) {
      <p class="error" role="alert">{{ text }}</p>
    }
    @if (data(); as data) {
      <h2 class="app-section-label">Directories without session</h2>
      @for (orphan of data.orphans; track orphan.path) {
        <section class="entry" data-testid="orphan">
          <div class="head">
            <strong>{{ kindLabels[orphan.kind] }}</strong>
            @if (orphan.branch) {
              <span class="muted">{{ orphan.branch }}</span>
            }
          </div>
          <code class="path">{{ orphan.path }}</code>
          @if (orphan.loss; as loss) {
            <app-loss-details
              [loss]="loss"
              [scratch]="orphan.kind !== 'clone'"
            />
          } @else {
            <p class="error">
              What it holds could not be read{{
                orphan.error ? ': ' + orphan.error : ''
              }}.
            </p>
          }
          @if (confirming() === orphan.path) {
            <div class="confirm">
              <p>Remove this directory for good? This cannot be undone.</p>
              @if (!orphan.loss?.clean) {
                <mat-checkbox
                  [(ngModel)]="acceptLoss"
                  data-testid="orphan-accept-loss"
                  >I accept losing what it holds</mat-checkbox
                >
              }
              <div class="buttons">
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
        <p class="empty" data-testid="no-orphans">
          <app-icon name="check" />None: every directory belongs to a session.
        </p>
      }
      <h2 class="app-section-label">Directories that are gone</h2>
      @for (entry of data.missing; track entry.sessionId + entry.position) {
        <section class="entry" data-testid="missing">
          <div class="head">
            <strong>{{ entry.name }}</strong> of
            <a [routerLink]="['/sessions', entry.sessionId]">{{
              entry.sessionTitle || 'Untitled session'
            }}</a>
          </div>
          <code class="path">{{ entry.path }}</code>
          <p class="muted">
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
        <p class="empty" data-testid="no-missing">
          <app-icon name="check" />None: every session has its directories.
        </p>
      }
    }
  `,
  styles: `
    :host {
      gap: var(--app-space-2);
    }
    .empty {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      padding: 12px;
      border: 1px dashed var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-medium);
      color: var(--mat-sys-on-surface-variant);
      --app-icon-size: 18px;
    }
    .entry {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      padding: 12px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-medium);
      background: var(--mat-sys-surface-container-low);
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
    }
    .path {
      overflow-wrap: anywhere;
      font: var(--mat-sys-body-small);
    }
    app-loss-details {
      align-self: stretch;
    }
    .muted {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
    }
    .error {
      margin: 0;
      color: var(--mat-sys-error);
    }
    .confirm p {
      margin: 4px 0;
    }
    .buttons {
      display: flex;
      gap: 8px;
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
