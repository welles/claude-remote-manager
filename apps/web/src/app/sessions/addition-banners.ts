import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type {
  SessionDirectoryDto,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { AppBanner } from '../ui/banner';
import { directoryName } from './session-directories';
import { SessionsApi } from './sessions-api';

/**
 * Repositories added while the session ran that did not become part of it:
 * the clone failed (retry or remove) or the setup script failed (run it
 * again, use the repository anyway, or remove it), like the banner of a
 * session whose first message is held back. The session itself goes on.
 */
@Component({
  selector: 'app-addition-banners',
  imports: [AppBanner, MatButtonModule],
  template: `
    @for (directory of blocked(); track directory.path) {
      @let name = directoryName(directory);
      <app-banner kind="attention" data-testid="addition-banner">
        @if (directory.addition?.state === 'held') {
          The setup script of <strong>{{ name }}</strong> failed, so Claude does
          not have it yet: run it again, use it anyway, or remove it.
        } @else {
          <strong>{{ name }}</strong> could not be added:
          {{ directory.addition?.error ?? 'the clone failed' }}.
        }
        <div banner-actions>
          <button
            matButton="filled"
            (click)="act(directory, 'retry')"
            [disabled]="!enabled() || busy()"
            data-testid="addition-retry"
          >
            {{
              directory.addition?.state === 'held' ? 'Run setup again' : 'Retry'
            }}
          </button>
          @if (directory.addition?.state === 'held') {
            <button
              matButton="outlined"
              (click)="act(directory, 'accept')"
              [disabled]="!enabled() || busy()"
              data-testid="addition-accept"
            >
              Use anyway
            </button>
          }
          <button
            matButton
            (click)="act(directory, 'remove')"
            [disabled]="!enabled() || busy()"
            data-testid="addition-remove"
          >
            Remove
          </button>
        </div>
      </app-banner>
    }
    @if (error(); as message) {
      <p class="app-error" data-testid="addition-error">{{ message }}</p>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--app-space-2);
    }
    :host(:empty) {
      display: none;
    }
    .app-error {
      margin: 0;
      overflow-wrap: anywhere;
    }
  `,
})
export class AdditionBanners {
  private readonly api = inject(SessionsApi);

  readonly session = input.required<SessionDto>();
  readonly enabled = input(true);
  readonly changed = output<SessionDto>();

  protected readonly directoryName = directoryName;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly blocked = computed(() =>
    this.session().archivedAt
      ? []
      : this.session().directories.filter(
          (directory) =>
            directory.addition?.state === 'failed' ||
            directory.addition?.state === 'held',
        ),
  );

  protected act(
    directory: SessionDirectoryDto,
    action: 'retry' | 'accept' | 'remove',
  ): void {
    const repositoryId = directory.repository?.id;
    if (!repositoryId || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.api
      .additionAction(this.session().id, repositoryId, action, directory.branch)
      .subscribe({
        next: (session) => {
          this.busy.set(false);
          this.changed.emit(session);
        },
        error: (error: unknown) => {
          this.busy.set(false);
          this.error.set(errorMessage(error, 'That did not work.'));
        },
      });
  }
}
