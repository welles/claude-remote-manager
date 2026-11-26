import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import type {
  CommitDiffResponse,
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

  /** One commit of a session clone with its diff against its parent. */
  @Get('commit')
  commitDiff(
    @Param('id') id: string,
    @Query('repositoryId') repositoryId: unknown,
    @Query('sha') sha: unknown,
    @Query('branch') branch: unknown,
  ): Promise<CommitDiffResponse> {
    if (typeof repositoryId !== 'string' || typeof sha !== 'string') {
      throw new BadRequestException('repositoryId and sha are required');
    }
    return this.diffs.commitDiff(id, repositoryId, branchParam(branch), sha);
  }

  /** One file of a commit's diff, e.g. one left out for its size. */
  @Get('commit/file')
  commitFileDiff(
    @Param('id') id: string,
    @Query('repositoryId') repositoryId: unknown,
    @Query('sha') sha: unknown,
    @Query('path') path: unknown,
    @Query('oldPath') oldPath: unknown,
    @Query('branch') branch: unknown,
  ): Promise<SessionDiffFile> {
    if (
      typeof repositoryId !== 'string' ||
      typeof sha !== 'string' ||
      typeof path !== 'string'
    ) {
      throw new BadRequestException('repositoryId, sha and path are required');
    }
    if (oldPath !== undefined && typeof oldPath !== 'string') {
      throw new BadRequestException('oldPath must be a string');
    }
    return this.diffs.commitFileDiff(
      id,
      repositoryId,
      branchParam(branch),
      sha,
      path,
      oldPath || null,
    );
  }
}
