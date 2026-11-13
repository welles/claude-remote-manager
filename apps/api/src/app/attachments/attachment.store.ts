import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt } from 'drizzle-orm';
import {
  ATTACHMENT_MEDIA_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type AttachmentDto,
  type AttachmentMediaType,
} from '@claude-remote-manager/shared-types';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DATABASE, type AppDatabase } from '../db/database';
import { attachments, type AttachmentRow } from '../db/schema';
import { sniffImageType } from './image-type';

/** Uploads no message took are removed after this long. */
export const UNCLAIMED_TTL_MS = 24 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An image of a message as Claude Code gets it. */
export interface AgentImage {
  mediaType: AttachmentMediaType;
  /** Base64. */
  data: string;
}

const toDto = (row: AttachmentRow): AttachmentDto => ({
  id: row.id,
  name: row.name,
  mediaType: row.mediaType as AttachmentMediaType,
  size: row.size,
});

/**
 * Images attached to user messages, in the API's own files directory (not
 * readable or writable by sessions). An upload is checked (type by its
 * content, size) and kept unclaimed until a message takes it; it then
 * belongs to that message of that session for good, so the history shows
 * it after reloads. A session's images go when the session is removed
 * (`removeSession`, and the database's cascade); unclaimed uploads after a
 * day.
 */
@Injectable()
export class AttachmentStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AttachmentStore.name);
  private readonly dir: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(DATABASE) private readonly db: AppDatabase,
  ) {
    this.dir = join(config.filesDir, 'attachments');
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** Stores an uploaded image (not yet part of a message). */
  async create(
    data: Buffer,
    declaredType: string,
    name: string | null,
  ): Promise<AttachmentDto> {
    if (!ATTACHMENT_MEDIA_TYPES.includes(declaredType as AttachmentMediaType)) {
      throw new BadRequestException(
        `Only ${ATTACHMENT_MEDIA_TYPES.join(', ')} images can be attached`,
      );
    }
    if (data.length === 0) {
      throw new BadRequestException('The image is empty');
    }
    if (data.length > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException(
        `The image is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`,
      );
    }
    const actual = sniffImageType(data);
    if (actual !== declaredType) {
      throw new BadRequestException(
        `The file is not a ${declaredType.replace('image/', '').toUpperCase()} image`,
      );
    }
    const id = randomUUID();
    // The row first: the sweep removes files without a row.
    const row = this.db
      .insert(attachments)
      .values({
        id,
        name: cleanName(name),
        mediaType: actual,
        size: data.length,
      })
      .returning()
      .get();
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFile(this.path(id), data, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      this.db.delete(attachments).where(eq(attachments.id, id)).run();
      throw error;
    }
    return toDto(row);
  }

  /** Checks that uploads exist and no message took them yet. */
  check(ids: string[]): void {
    this.validate(ids);
    if (ids.length === 0) {
      return;
    }
    const free = this.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(and(inArray(attachments.id, ids), isNull(attachments.sessionId)))
      .all();
    if (free.length !== ids.length) {
      throw new BadRequestException(
        'An attachment does not exist or belongs to another message',
      );
    }
  }

  /**
   * Gives uploads to a message. IDs must be unclaimed uploads, or already
   * this message's (a repeated send). Returns them in the given order.
   */
  claim(ids: string[], sessionId: string, messageId: string): AttachmentDto[] {
    this.validate(ids);
    if (ids.length === 0) {
      return [];
    }
    return this.db.transaction((tx) => {
      const rows = tx
        .select()
        .from(attachments)
        .where(inArray(attachments.id, ids))
        .all();
      const byId = new Map(rows.map((row) => [row.id, row]));
      ids.forEach((id, position) => {
        const row = byId.get(id);
        const mine =
          row?.sessionId === sessionId && row.messageId === messageId;
        if (!row || (!mine && row.sessionId !== null)) {
          throw new BadRequestException(
            `Attachment ${id} does not exist or belongs to another message`,
          );
        }
        if (!mine) {
          tx.update(attachments)
            .set({ sessionId, messageId, position })
            .where(and(eq(attachments.id, id), isNull(attachments.sessionId)))
            .run();
        }
      });
      return ids.map((id) => toDto(byId.get(id) as AttachmentRow));
    });
  }

  /** The images of a message, in order. */
  forMessage(sessionId: string, messageId: string): AttachmentDto[] {
    return this.db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.sessionId, sessionId),
          eq(attachments.messageId, messageId),
        ),
      )
      .orderBy(asc(attachments.position))
      .all()
      .map(toDto);
  }

  /** The images of all messages of a session, by message ID. */
  forSession(sessionId: string): Map<string, AttachmentDto[]> {
    const result = new Map<string, AttachmentDto[]>();
    for (const row of this.db
      .select()
      .from(attachments)
      .where(eq(attachments.sessionId, sessionId))
      .orderBy(asc(attachments.messageId), asc(attachments.position))
      .all()) {
      if (row.messageId) {
        result.set(row.messageId, [
          ...(result.get(row.messageId) ?? []),
          toDto(row),
        ]);
      }
    }
    return result;
  }

  /** The images of a message as Claude Code gets them. */
  async agentImages(
    sessionId: string,
    messageId: string,
  ): Promise<AgentImage[]> {
    const images: AgentImage[] = [];
    for (const attachment of this.forMessage(sessionId, messageId)) {
      images.push({
        mediaType: attachment.mediaType,
        data: (await readFile(this.path(attachment.id))).toString('base64'),
      });
    }
    return images;
  }

  /** An image to serve. */
  content(id: string): { path: string; attachment: AttachmentDto } {
    const row = UUID.test(id)
      ? this.db.select().from(attachments).where(eq(attachments.id, id)).get()
      : undefined;
    if (!row) {
      throw new NotFoundException('No such attachment');
    }
    return { path: this.path(id), attachment: toDto(row) };
  }

  /** Removes the images of a session (files and rows). */
  async removeSession(sessionId: string): Promise<void> {
    const rows = this.db
      .delete(attachments)
      .where(eq(attachments.sessionId, sessionId))
      .returning()
      .all();
    await Promise.all(
      rows.map((row) => rm(this.path(row.id), { force: true })),
    );
  }

  /**
   * Removes unclaimed uploads older than {@link UNCLAIMED_TTL_MS} and files
   * without a row (their session was removed from the database).
   */
  async sweep(now = Date.now()): Promise<void> {
    try {
      this.db
        .delete(attachments)
        .where(
          and(
            isNull(attachments.sessionId),
            lt(attachments.createdAt, new Date(now - UNCLAIMED_TTL_MS)),
          ),
        )
        .run();
      // Files first: a file listed here has its row already.
      const files = await readdir(this.dir);
      const known = new Set(
        this.db
          .select({ id: attachments.id })
          .from(attachments)
          .all()
          .map((row) => row.id),
      );
      for (const name of files) {
        if (!known.has(name)) {
          await rm(join(this.dir, name), { force: true });
        }
      }
    } catch (error) {
      this.logger.warn(`Cleaning up attachments failed: ${String(error)}`);
    }
  }

  private validate(ids: string[]): void {
    if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new BadRequestException(
        `At most ${MAX_ATTACHMENTS_PER_MESSAGE} images per message`,
      );
    }
    if (new Set(ids).size !== ids.length || !ids.every((id) => UUID.test(id))) {
      throw new BadRequestException(
        'attachmentIds must be distinct upload IDs',
      );
    }
  }

  private path(id: string): string {
    return join(this.dir, id);
  }
}

/** A file name to show: no paths or control characters, at most 200 chars. */
function cleanName(name: string | null): string | null {
  const base = name?.split(/[\\/]/).at(-1) ?? '';
  const clean = [...base]
    .filter((char) => char >= ' ' && char !== '\u007f')
    .join('')
    .trim()
    .slice(0, 200);
  return clean || null;
}
