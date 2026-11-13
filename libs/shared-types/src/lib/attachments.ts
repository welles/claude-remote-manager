/**
 * Images attached to user messages: uploaded first
 * (`POST /api/attachments` with the image as body), then sent with the
 * message (`attachmentIds`), which gives them to Claude as image content of
 * the user message. Served at `GET /api/attachments/:id`.
 */

/** Image types Claude accepts. */
export const ATTACHMENT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type AttachmentMediaType = (typeof ATTACHMENT_MEDIA_TYPES)[number];

/** Largest image (bytes): the Claude API's limit per image. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Most images per message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

export interface AttachmentDto {
  id: string;
  /** File name as uploaded, if any. */
  name: string | null;
  mediaType: AttachmentMediaType;
  size: number;
}
