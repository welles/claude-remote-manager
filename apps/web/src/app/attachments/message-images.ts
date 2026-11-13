import { Component, input } from '@angular/core';
import type { AttachmentDto } from '@claude-remote-manager/shared-types';
import { attachmentUrl } from './attachments-api';

/** The images of a sent message, as thumbnails that open the image. */
@Component({
  selector: 'app-message-images',
  template: `
    @for (attachment of attachments(); track attachment.id) {
      <a
        [href]="url(attachment.id)"
        target="_blank"
        rel="noopener"
        data-testid="message-image"
        ><img
          [src]="url(attachment.id)"
          [alt]="attachment.name ?? 'Attached image'"
          loading="lazy"
      /></a>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    img {
      display: block;
      max-width: 160px;
      max-height: 120px;
      border-radius: 6px;
      object-fit: contain;
      background: var(--mat-sys-surface-container);
    }
  `,
})
export class MessageImages {
  readonly attachments = input.required<AttachmentDto[]>();
  protected readonly url = attachmentUrl;
}
