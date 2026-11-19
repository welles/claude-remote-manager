import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  BrowseResponse,
  BrowsedFileDto,
  FileMentionsResponse,
} from '@claude-remote-manager/shared-types';
import { shownFileHeaders } from '../shown-files/shown-file-headers';
import { FileMentionsService } from './file-mentions.service';
import { FileAccessError } from './session-file-access';

/** Files of a session for `@` references in the input. */
@Controller('sessions/:id/files')
export class SessionFilesController {
  constructor(private readonly mentions: FileMentionsService) {}

  @Get()
  search(
    @Param('id') id: string,
    @Query('query') query: unknown,
    @Query('limit') limit: unknown,
  ): Promise<FileMentionsResponse> {
    if (query !== undefined && typeof query !== 'string') {
      throw new BadRequestException('query must be a string');
    }
    const count = limit === undefined ? undefined : Number(limit);
    if (count !== undefined && !Number.isInteger(count)) {
      throw new BadRequestException('limit must be a number');
    }
    return this.mentions.search(id, query ?? '', count);
  }
}

/** The query of a browsed file: the directory's position and the path. */
function browsedQuery(
  directory: unknown,
  path: unknown,
): { position: number; path: string } {
  const position = Number(directory);
  if (!Number.isInteger(position) || position < 0) {
    throw new BadRequestException('directory must be a position');
  }
  if (typeof path !== 'string') {
    throw new BadRequestException('path must be a string');
  }
  return { position, path };
}

/** HTTP errors for files the helper refused. */
function accessError(error: unknown): unknown {
  if (!(error instanceof FileAccessError)) {
    return error;
  }
  switch (error.code) {
    case 'not_found':
      return new NotFoundException('No such file');
    case 'outside':
      return new ForbiddenException('The file is outside the directory');
    case 'no_access':
      return new ForbiddenException('The file cannot be read');
    case 'not_regular':
      return new BadRequestException('Not a regular file');
    default:
      return error;
  }
}

/**
 * The file browser: a session's directories with their files, and a file's
 * kind and content, read as the session user and only inside the
 * directory (served like shown files: never sniffed, sandboxed).
 */
@Controller('sessions/:id/browse')
export class SessionBrowseController {
  constructor(private readonly files: FileMentionsService) {}

  @Get()
  directories(@Param('id') id: string): Promise<BrowseResponse> {
    return this.files.browse(id);
  }

  @Get('file')
  async file(
    @Param('id') id: string,
    @Query('directory') directory: unknown,
    @Query('path') path: unknown,
  ): Promise<BrowsedFileDto> {
    const query = browsedQuery(directory, path);
    try {
      return await this.files.browsedFile(id, query.position, query.path);
    } catch (error) {
      throw accessError(error);
    }
  }

  @Get('content')
  async content(
    @Param('id') id: string,
    @Query('directory') directory: unknown,
    @Query('path') path: unknown,
    @Query('download') download: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const query = browsedQuery(directory, path);
    let file: BrowsedFileDto;
    let opened: Awaited<ReturnType<FileMentionsService['openBrowsed']>>;
    try {
      file = await this.files.browsedFile(id, query.position, query.path);
      opened = await this.files.openBrowsed(id, query.position, query.path);
    } catch (error) {
      throw accessError(error);
    }
    response.set({
      ...shownFileHeaders(
        file,
        opened.size,
        download === '1' || opened.truncated,
      ),
      'Cache-Control': 'no-store',
    });
    // The file may change while it is sent.
    response.removeHeader('Content-Length');
    opened.content.on('error', () => response.destroy()).pipe(response);
    response.on('close', () => opened.content.destroy());
  }
}
