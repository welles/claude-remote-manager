import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import type { FileMentionsResponse } from '@claude-remote-manager/shared-types';
import { FileMentionsService } from './file-mentions.service';

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
