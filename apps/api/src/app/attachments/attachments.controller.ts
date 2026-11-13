import { createReadStream } from 'node:fs';
import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  MAX_ATTACHMENT_BYTES,
  type AttachmentDto,
} from '@claude-remote-manager/shared-types';
import { AttachmentStore } from './attachment.store';

/**
 * Headers of content that came from users or sessions, served from the
 * app's own origin: never sniffed into another type, never run as a page
 * with the app's privileges (`sandbox` gives it an opaque origin even when
 * opened directly), loads nothing.
 */
export const CONTENT_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'private, max-age=31536000, immutable',
};

/** Reads a raw request body, refusing more than `limit` bytes. */
export function readBody(request: Request, limit: number): Promise<Buffer> {
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > limit) {
    return Promise.reject(
      new PayloadTooLargeException(`The body is larger than ${limit} bytes`),
    );
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        request.pause();
        reject(
          new PayloadTooLargeException(
            `The body is larger than ${limit} bytes`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/**
 * Images for user messages. Uploads are the API's only non-JSON request
 * bodies: the request guard lets image bodies through to this route only
 * (see `RAW_BODY_ROUTES`).
 */
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly store: AttachmentStore) {}

  /**
   * Uploads an image (body: the image, `Content-Type` its type; optional
   * `X-File-Name`, URL-encoded). It is attached when a message names it.
   */
  @Post()
  @HttpCode(201)
  async upload(@Req() request: Request): Promise<AttachmentDto> {
    const type = (request.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const body = await readBody(request, MAX_ATTACHMENT_BYTES);
    let name: string | null = null;
    const header = request.headers['x-file-name'];
    if (typeof header === 'string' && header) {
      try {
        name = decodeURIComponent(header);
      } catch {
        throw new BadRequestException('X-File-Name must be URL-encoded');
      }
    }
    return this.store.create(body, type, name);
  }

  @Get(':id')
  content(@Param('id') id: string, @Res() response: Response): void {
    const { path, attachment } = this.store.content(id);
    response.set({
      ...CONTENT_SECURITY_HEADERS,
      'Content-Type': attachment.mediaType,
      'Content-Length': String(attachment.size),
      'Content-Disposition': 'inline',
    });
    createReadStream(path)
      .on('error', () => response.destroy())
      .pipe(response);
  }
}
