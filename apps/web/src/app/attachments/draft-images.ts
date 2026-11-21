import { Component, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type { AttachmentDrafts } from './attachment-drafts';

/** Previews of the images of a message being written, each removable. */
@Component({
  selector: 'app-draft-images',
  imports: [MatButtonModule],
  template: `
    @if (drafts().images().length > 0) {
      <ul
        class="mt-0 mb-2 flex list-none flex-wrap gap-2 p-0"
        data-testid="draft-images"
      >
        @for (image of drafts().images(); track image.key) {
          @let pending = image.state !== 'ready';
          <li
            class="relative size-16 overflow-hidden rounded-sm bg-surface-container"
            data-testid="draft-image"
          >
            <img
              class="size-full object-cover"
              [class.opacity-40]="pending"
              [src]="image.preview"
              [alt]="image.name"
            />
            @if (image.state === 'uploading') {
              <span
                class="absolute inset-x-0 bottom-0 bg-surface text-center type-label-small"
                >Uploading…</span
              >
            } @else if (image.state === 'failed') {
              <span
                class="absolute inset-x-0 bottom-0 bg-surface text-center type-label-small text-error"
                [title]="image.error ?? ''"
                >Failed</span
              >
            }
            <button
              type="button"
              class="absolute top-0.5 right-0.5 size-6 cursor-pointer rounded-full border-0 bg-surface-container-highest text-[16px]/none text-on-surface"
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
      <p
        class="mt-0 mb-2 type-body-small text-error"
        data-testid="image-notice"
      >
        {{ notice }}
      </p>
    }
  `,
})
export class DraftImages {
  readonly drafts = input.required<AttachmentDrafts>();
}
