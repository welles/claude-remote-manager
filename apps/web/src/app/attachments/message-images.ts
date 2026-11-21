import { Component, input } from '@angular/core';
import type { AttachmentDto } from '@claude-remote-manager/shared-types';
import { attachmentUrl } from './attachments-api';

/** The images of a sent message, as thumbnails that open the image. */
@Component({
  selector: 'app-message-images',
  host: { class: 'flex flex-wrap gap-1.5' },
  template: `
    @for (attachment of attachments(); track attachment.id) {
      <a
        [href]="url(attachment.id)"
        target="_blank"
        rel="noopener"
        data-testid="message-image"
        ><img
          class="block max-h-[120px] max-w-[160px] rounded-sm bg-surface-container object-contain"
          [src]="url(attachment.id)"
          [alt]="attachment.name ?? 'Attached image'"
          loading="lazy"
      /></a>
    }
  `,
})
export class MessageImages {
  readonly attachments = input.required<AttachmentDto[]>();
  protected readonly url = attachmentUrl;
}
