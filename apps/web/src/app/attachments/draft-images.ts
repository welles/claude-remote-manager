import { Component, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type { AttachmentDrafts } from './attachment-drafts';

/** Previews of the images of a message being written, each removable. */
@Component({
  selector: 'app-draft-images',
  imports: [MatButtonModule],
  template: `
    @if (drafts().images().length > 0) {
      <ul class="images" data-testid="draft-images">
        @for (image of drafts().images(); track image.key) {
          <li class="image state-{{ image.state }}" data-testid="draft-image">
            <img [src]="image.preview" [alt]="image.name" />
            @if (image.state === 'uploading') {
              <span class="label">Uploading…</span>
            } @else if (image.state === 'failed') {
              <span class="label" [title]="image.error ?? ''">Failed</span>
            }
            <button
              type="button"
              class="remove"
              (click)="drafts().remove(image.key)"
              [attr.aria-label]="'Remove ' + image.name"
              data-testid="remove-image"
            >
              ×
            </button>
          </li>
        }
      </ul>
    }
    @if (drafts().notice(); as notice) {
      <p class="notice" data-testid="image-notice">{{ notice }}</p>
    }
  `,
  styles: `
    .images {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 8px;
      padding: 0;
      list-style: none;
    }
    .image {
      position: relative;
      width: 64px;
      height: 64px;
      border-radius: var(--mat-sys-corner-small);
      overflow: hidden;
      background: var(--mat-sys-surface-container);
    }
    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .state-uploading img,
    .state-failed img {
      opacity: 0.4;
    }
    .label {
      position: absolute;
      inset: auto 0 0 0;
      font: var(--mat-sys-label-small);
      text-align: center;
      background: var(--mat-sys-surface);
    }
    .state-failed .label {
      color: var(--mat-sys-error);
    }
    .remove {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 50%;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      color: var(--mat-sys-on-surface);
      background: var(--mat-sys-surface-container-highest);
    }
    .notice {
      margin: 0 0 8px;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-error);
    }
  `,
})
export class DraftImages {
  readonly drafts = input.required<AttachmentDrafts>();
}
