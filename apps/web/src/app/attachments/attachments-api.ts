import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { AttachmentDto } from '@claude-remote-manager/shared-types';

/** URL of an attached image. */
export const attachmentUrl = (id: string) =>
  `/api/attachments/${encodeURIComponent(id)}`;

/** Uploads images for messages. */
@Injectable({ providedIn: 'root' })
export class AttachmentsApi {
  private readonly http = inject(HttpClient);

  upload(file: Blob, name: string | null): Observable<AttachmentDto> {
    return this.http.post<AttachmentDto>('/api/attachments', file, {
      headers: {
        'Content-Type': file.type,
        ...(name ? { 'X-File-Name': encodeURIComponent(name) } : {}),
      },
    });
  }
}
