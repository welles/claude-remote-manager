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
  host: { class: 'block' },
  template: `
    @let p = preview();
    <div
      class="item-card"
      data-testid="preview-card"
      [attr.data-state]="p.state"
    >
      <div class="flex min-w-0 flex-[1_1_200px] flex-col">
        <span class="font-medium wrap-anywhere">{{ p.name }}</span>
        <span class="hint-text">
          <span
            [class]="
              p.state === 'running'
                ? 'text-primary'
                : p.state === 'unreachable'
                  ? 'text-error'
                  : ''
            "
            data-testid="preview-state"
            >{{ stateLabel() }}</span
          >
          · port {{ p.port }}
        </span>
        @if (href(); as link) {
          @if (p.state !== 'stopped') {
            <a
              class="type-body-small wrap-anywhere"
              [href]="link"
              target="_blank"
              rel="noopener noreferrer"
              referrerpolicy="no-referrer"
              data-testid="preview-link"
              >{{ link }}</a
            >
          } @else {
            <span
              class="type-body-small text-on-surface-variant line-through wrap-anywhere"
              >{{ link }}</span
            >
          }
        }
        @if (p.problem) {
          <span class="hint-text" data-testid="preview-problem">{{
            p.problem
          }}</span>
        }
        @if (error(); as message) {
          <span class="hint-text">{{ message }}</span>
        }
      </div>
      @if (p.state !== 'stopped') {
        <div class="flex gap-1">
          <button matButton (click)="embed.emit(p)" data-testid="preview-embed">
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
