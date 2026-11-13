import { createReadStream } from 'node:fs';
import {
  Controller,
  GoneException,
  Get,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ShownFileDto } from '@claude-remote-manager/shared-types';
import {
  FileAccessError,
  SessionFileAccess,
} from '../files/session-file-access';
import { shownFileHeaders } from './shown-file-headers';
import { ShownFilesService } from './shown-files.service';

/** The live file is served up to this size. */
export const MAX_LIVE_BYTES = 512 * 1024 * 1024;

/** Files Claude showed: their metadata, snapshot and (large ones) live file. */
@Controller('shown-files')
export class ShownFilesController {
  constructor(
    private readonly files: ShownFilesService,
    private readonly access: SessionFileAccess,
  ) {}

  @Get(':id')
  get(@Param('id') id: string): ShownFileDto {
    return this.files.get(id);
  }

  /** The content as it was when shown. */
  @Get(':id/content')
  content(
    @Param('id') id: string,
    @Query('download') download: unknown,
    @Res() response: Response,
  ): void {
    const { file, path } = this.files.snapshotPath(id);
    if (!path) {
      throw new GoneException(
        'The file was too large to keep a copy; open the current file instead',
      );
    }
    response.set(shownFileHeaders(file, file.size, download === '1'));
    createReadStream(path)
      .on('error', () => response.destroy())
      .pipe(response);
  }

  /**
   * The file as it is now (for files too large for a snapshot), read as
   * the session user and only inside the session's directories, while
   * they exist.
   */
  @Get(':id/live')
  async live(
    @Param('id') id: string,
    @Query('download') download: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const { file, roots } = this.files.liveRoots(id);
    let opened: Awaited<ReturnType<SessionFileAccess['stream']>>;
    try {
      opened = await this.access.stream(roots, file.path, MAX_LIVE_BYTES);
    } catch (error) {
      if (error instanceof FileAccessError) {
        throw new GoneException(
          `The file is no longer available (${error.message})`,
        );
      }
      throw error;
    }
    const size = Math.min(opened.size, MAX_LIVE_BYTES);
    response.set({
      ...shownFileHeaders(file, size, download === '1' || opened.truncated),
      'Cache-Control': 'no-store',
    });
    // The file may change while it is sent.
    response.removeHeader('Content-Length');
    opened.content.on('error', () => response.destroy()).pipe(response);
    response.on('close', () => opened.content.destroy());
  }
}
