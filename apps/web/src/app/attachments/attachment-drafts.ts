import { computed, signal } from '@angular/core';
import {
  ATTACHMENT_MEDIA_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type AttachmentDto,
  type AttachmentMediaType,
} from '@claude-remote-manager/shared-types';
import { errorMessage } from '../repositories/repositories-api';
import { attachmentUrl, type AttachmentsApi } from './attachments-api';

/** An image added to a message that is not sent yet. */
export interface DraftImage {
  key: number;
  name: string;
  /** Preview: an object URL of the file, or the uploaded image. */
  preview: string;
  state: 'uploading' | 'ready' | 'failed';
  attachment: AttachmentDto | null;
  error: string | null;
}

/** Image files of a paste or drop, or of a file input. */
export function imageFiles(
  list: FileList | DataTransferItemList | null,
): File[] {
  const files: File[] = [];
  if (!list) {
    return files;
  }
  for (let index = 0; index < list.length; index++) {
    const entry: File | DataTransferItem | null = list[index];
    const file =
      entry instanceof File
        ? entry
        : entry?.kind === 'file'
          ? entry.getAsFile()
          : null;
    if (file && file.type.startsWith('image/')) {
      files.push(file);
    }
  }
  return files;
}

let nextKey = 1;

/**
 * The images of a message being written: each is uploaded right away
 * (checked again by the server), previewed, and can be removed before
 * sending. The message then names the uploads (`attachmentIds`).
 */
export class AttachmentDrafts {
  readonly images = signal<DraftImage[]>([]);
  /** An image is still uploading. */
  readonly busy = computed(() =>
    this.images().some((image) => image.state === 'uploading'),
  );
  /** IDs of the uploaded images, in order. */
  readonly ids = computed(() =>
    this.images().flatMap((image) =>
      image.attachment && image.state === 'ready' ? [image.attachment.id] : [],
    ),
  );
  /** Why files were not added (type, size, count). */
  readonly notice = signal<string | null>(null);

  constructor(private readonly api: AttachmentsApi) {}

  add(files: File[]): void {
    const problems: string[] = [];
    for (const file of files) {
      if (this.images().length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        problems.push(
          `At most ${MAX_ATTACHMENTS_PER_MESSAGE} images per message.`,
        );
        break;
      }
      if (!ATTACHMENT_MEDIA_TYPES.includes(file.type as AttachmentMediaType)) {
        problems.push(
          `${file.name || 'The file'}: only PNG, JPEG, GIF and WebP images.`,
        );
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        problems.push(`${file.name || 'The image'} is larger than 5 MB.`);
        continue;
      }
      this.upload(file);
    }
    this.notice.set(problems.length > 0 ? problems.join(' ') : null);
  }

  remove(key: number): void {
    const image = this.images().find((entry) => entry.key === key);
    if (image?.preview.startsWith('blob:')) {
      URL.revokeObjectURL(image.preview);
    }
    this.images.update((images) => images.filter((entry) => entry.key !== key));
  }

  /** Images uploaded before (e.g. of a message that was not sent). */
  restore(attachments: AttachmentDto[]): void {
    this.images.update((images) => [
      ...images,
      ...attachments.map(
        (attachment): DraftImage => ({
          key: nextKey++,
          name: attachment.name ?? 'image',
          preview: attachmentUrl(attachment.id),
          state: 'ready',
          attachment,
          error: null,
        }),
      ),
    ]);
  }

  clear(): void {
    for (const image of this.images()) {
      if (image.preview.startsWith('blob:')) {
        URL.revokeObjectURL(image.preview);
      }
    }
    this.images.set([]);
    this.notice.set(null);
  }

  private upload(file: File): void {
    const key = nextKey++;
    this.images.update((images) => [
      ...images,
      {
        key,
        name: file.name || 'pasted image',
        preview: URL.createObjectURL(file),
        state: 'uploading',
        attachment: null,
        error: null,
      },
    ]);
    const update = (patch: Partial<DraftImage>) =>
      this.images.update((images) =>
        images.map((image) =>
          image.key === key ? { ...image, ...patch } : image,
        ),
      );
    this.api.upload(file, file.name || null).subscribe({
      next: (attachment) => update({ state: 'ready', attachment }),
      error: (error: unknown) =>
        update({
          state: 'failed',
          error: errorMessage(error, 'The upload failed.'),
        }),
    });
  }
}
