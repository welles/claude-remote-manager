import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { Subject } from 'rxjs';
import {
  MAX_SNAPSHOT_BYTES,
  type ShownFileDto,
  type ShownFileOrigin,
} from '@claude-remote-manager/shared-types';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DATABASE, type AppDatabase } from '../db/database';
import { shownFiles, type ShownFileRow } from '../db/schema';
import { SessionFileAccess } from '../files/session-file-access';
import { SessionRepository } from '../sessions/session.repository';
import { classifyFile } from './file-kind';

const MAX_CAPTION_LENGTH = 500;

/** A file was shown in a session. */
export interface FileShown {
  sessionId: string;
  toolUseId: string | null;
  file: ShownFileDto;
}

const toDto = (row: ShownFileRow): ShownFileDto => ({
  id: row.id,
  origin: row.origin,
  path: row.path,
  name: row.name,
  caption: row.caption,
  kind: row.kind,
  mediaType: row.mediaType,
  language: row.language,
  size: row.size,
  snapshot: row.snapshot,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Files put in front of the user. A file is read once, as the session user
 * and only inside the session's directories (see {@link SessionFileAccess}),
 * and its content kept as a snapshot in the API's files directory, which
 * sessions cannot reach; files above {@link MAX_SNAPSHOT_BYTES} keep only
 * their metadata. Snapshots go with their session (`removeSession`, and
 * the database's cascade; files without a row are removed at startup).
 */
@Injectable()
export class ShownFilesService implements OnModuleInit {
  private readonly logger = new Logger(ShownFilesService.name);
  private readonly dir: string;
  private readonly shown = new Subject<FileShown>();
  /** Files shown, for the session's event log. */
  readonly shown$ = this.shown.asObservable();
  /** Largest snapshot (replaceable in tests). */
  maxSnapshotBytes = MAX_SNAPSHOT_BYTES;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(DATABASE) private readonly db: AppDatabase,
    private readonly sessions: SessionRepository,
    private readonly files: SessionFileAccess,
  ) {
    this.dir = join(config.filesDir, 'shown');
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.sweep();
  }

  /**
   * Shows a file of the session (tool `show_file`, an image Claude wrote).
   * Throws a {@link FileAccessError} for files outside the session's
   * directories, missing or special files.
   */
  async show(
    sessionId: string,
    toolUseId: string | null,
    path: string,
    caption: string | null,
    origin: ShownFileOrigin,
  ): Promise<ShownFileDto> {
    const file = await this.files.read(
      this.roots(sessionId),
      path,
      this.maxSnapshotBytes,
    );
    return this.store(sessionId, toolUseId, origin, {
      path: file.path,
      caption,
      data: file.data,
      size: file.size,
      complete: !file.truncated,
    });
  }

  /** Shows content Claude Code reported (an image Claude read). */
  fromData(
    sessionId: string,
    toolUseId: string | null,
    path: string,
    data: Buffer,
    origin: ShownFileOrigin,
  ): Promise<ShownFileDto> {
    return this.store(sessionId, toolUseId, origin, {
      path,
      caption: null,
      data,
      size: data.length,
      complete: true,
    });
  }

  get(id: string): ShownFileDto {
    return toDto(this.row(id));
  }

  /** The snapshot's file, if the content was kept. */
  snapshotPath(id: string): { file: ShownFileDto; path: string | null } {
    const file = this.get(id);
    return { file, path: file.snapshot ? join(this.dir, id) : null };
  }

  /**
   * The directories the live file may be read from: the session's, while
   * they exist.
   */
  liveRoots(id: string): { file: ShownFileDto; roots: string[] } {
    const row = this.row(id);
    return { file: toDto(row), roots: this.roots(row.sessionId) };
  }

  forSession(sessionId: string): ShownFileDto[] {
    return this.db
      .select()
      .from(shownFiles)
      .where(eq(shownFiles.sessionId, sessionId))
      .orderBy(asc(shownFiles.createdAt))
      .all()
      .map(toDto);
  }

  /** Removes a session's snapshots (files and rows). */
  async removeSession(sessionId: string): Promise<void> {
    const rows = this.db
      .delete(shownFiles)
      .where(eq(shownFiles.sessionId, sessionId))
      .returning()
      .all();
    await Promise.all(
      rows.map((row) => rm(join(this.dir, row.id), { force: true })),
    );
  }

  /** Removes snapshot files without a row (their session is gone). */
  async sweep(): Promise<void> {
    try {
      const names = await readdir(this.dir);
      const known = new Set(
        this.db
          .select({ id: shownFiles.id })
          .from(shownFiles)
          .all()
          .map((row) => row.id),
      );
      for (const name of names) {
        if (!known.has(name)) {
          await rm(join(this.dir, name), { force: true });
        }
      }
    } catch (error) {
      this.logger.warn(`Cleaning up shown files failed: ${String(error)}`);
    }
  }

  private async store(
    sessionId: string,
    toolUseId: string | null,
    origin: ShownFileOrigin,
    content: {
      path: string;
      caption: string | null;
      data: Buffer;
      size: number;
      complete: boolean;
    },
  ): Promise<ShownFileDto> {
    const name = basename(content.path);
    const type = classifyFile(name, content.data, content.complete);
    const snapshot = content.complete;
    const caption =
      content.caption?.trim().slice(0, MAX_CAPTION_LENGTH) || null;
    const id = randomUUID();
    // The row first: the sweep removes files without a row.
    const row = this.db
      .insert(shownFiles)
      .values({
        id,
        sessionId,
        toolUseId,
        origin,
        path: content.path,
        name,
        caption,
        ...type,
        size: content.size,
        snapshot,
      })
      .returning()
      .get();
    if (snapshot) {
      try {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        await writeFile(join(this.dir, id), content.data, {
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        this.db.delete(shownFiles).where(eq(shownFiles.id, id)).run();
        throw error;
      }
    }
    const file = toDto(row);
    this.shown.next({ sessionId, toolUseId, file });
    return file;
  }

  private row(id: string): ShownFileRow {
    const row = /^[0-9a-f-]{36}$/i.test(id)
      ? this.db.select().from(shownFiles).where(eq(shownFiles.id, id)).get()
      : undefined;
    if (!row) {
      throw new NotFoundException('No such file');
    }
    return row;
  }

  /** The session's directories that exist. */
  private roots(sessionId: string): string[] {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    return record.directories
      .filter((directory) => directory.state === 'ready')
      .map((directory) => directory.path);
  }
}
