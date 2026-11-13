import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type { PreviewDto } from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { PREVIEW_STATE_LABELS, PreviewsApi, previewHref } from './previews-api';

/**
 * A preview of a dev server: name, state and link, with Embed (opens it in
 * a frame of the session view) and Stop (ends the forwarding). Used in the
 * session's preview list and in the history where Claude exposed it.
 */
@Component({
  selector: 'app-preview-card',
  imports: [MatButtonModule],
  template: `
    @let p = preview();
    <div class="card" data-testid="preview-card" [attr.data-state]="p.state">
      <div class="text">
        <span class="name">{{ p.name }}</span>
        <span class="meta">
          <span class="state state-{{ p.state }}" data-testid="preview-state">{{
            stateLabel()
          }}</span>
          · port {{ p.port }}
        </span>
        @if (href(); as link) {
          @if (p.state !== 'stopped') {
            <a
              class="url"
              [href]="link"
              target="_blank"
              rel="noopener noreferrer"
              referrerpolicy="no-referrer"
              data-testid="preview-link"
              >{{ link }}</a
            >
          } @else {
            <span class="url stopped">{{ link }}</span>
          }
        }
        @if (p.problem) {
          <span class="problem" data-testid="preview-problem">{{
            p.problem
          }}</span>
        }
        @if (error(); as message) {
          <span class="problem">{{ message }}</span>
        }
      </div>
      @if (p.state !== 'stopped') {
        <div class="actions">
          <button
            matButton="tonal"
            (click)="embed.emit(p)"
            data-testid="preview-embed"
          >
            Embed
          </button>
          <button
            matButton
            (click)="stop()"
            [disabled]="stopping()"
            data-testid="preview-stop"
          >
            Stop
          </button>
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .card {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px 12px;
      padding: 8px 12px;
      border-radius: var(--mat-sys-corner-small);
      background: var(--mat-sys-surface-container);
    }
    .text {
      display: flex;
      flex-direction: column;
      min-width: 0;
      flex: 1 1 200px;
    }
    .name {
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .meta,
    .problem {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .url {
      font: var(--mat-sys-body-small);
      overflow-wrap: anywhere;
    }
    .url.stopped {
      color: var(--mat-sys-on-surface-variant);
      text-decoration: line-through;
    }
    .state-running {
      color: var(--mat-sys-primary);
    }
    .state-unreachable {
      color: var(--mat-sys-error);
    }
    .actions {
      display: flex;
      gap: 4px;
    }
  `,
})
export class PreviewCard {
  private readonly api = inject(PreviewsApi);

  /** The preview as it is now (see `currentPreview`). */
  readonly preview = input.required<PreviewDto>();
  readonly embed = output<PreviewDto>();

  protected readonly href = computed(() => previewHref(this.preview()));
  protected readonly stateLabel = computed(
    () => PREVIEW_STATE_LABELS[this.preview().state],
  );
  protected readonly stopping = signal(false);
  protected readonly error = signal<string | null>(null);

  protected stop(): void {
    const preview = this.preview();
    this.stopping.set(true);
    this.error.set(null);
    // The session update removes it from the list.
    this.api.stop(preview.sessionId, preview.id).subscribe({
      next: () => this.stopping.set(false),
      error: (error: unknown) => {
        this.stopping.set(false);
        this.error.set(errorMessage(error, 'The preview could not be stopped'));
      },
    });
  }
}
