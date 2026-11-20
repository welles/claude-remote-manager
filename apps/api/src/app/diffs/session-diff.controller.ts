import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import type {
  SessionDiffFile,
  SessionDiffResponse,
} from '@claude-remote-manager/shared-types';
import { branchParam } from '../sessions/session-clones';
import { SessionDiffService } from './session-diff.service';

/**
 * What a session changed, per repository and file (also for the cleanup
 * of sessions).
 */
@Controller('sessions/:id/diff')
export class SessionDiffController {
  constructor(private readonly diffs: SessionDiffService) {}

  @Get()
  sessionDiff(@Param('id') id: string): Promise<SessionDiffResponse> {
    return this.diffs.sessionDiff(id);
  }

  /** One file, e.g. one left out of the session diff for its size. */
  @Get('file')
  fileDiff(
    @Param('id') id: string,
    @Query('repositoryId') repositoryId: unknown,
    @Query('path') path: unknown,
    @Query('oldPath') oldPath: unknown,
    @Query('branch') branch: unknown,
  ): Promise<SessionDiffFile> {
    if (typeof repositoryId !== 'string' || typeof path !== 'string') {
      throw new BadRequestException('repositoryId and path are required');
    }
    if (oldPath !== undefined && typeof oldPath !== 'string') {
      throw new BadRequestException('oldPath must be a string');
    }
    return this.diffs.fileDiff(
      id,
      repositoryId,
      path,
      oldPath || null,
      branchParam(branch),
    );
  }
}
