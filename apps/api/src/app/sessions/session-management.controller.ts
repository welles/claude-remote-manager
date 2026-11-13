import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type {
  ArchiveRequest,
  CleanupPreview,
  CleanupRequest,
  CleanupResult,
  DeleteSessionRequest,
  DeletionPreview,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { SessionManagementService } from './session-management.service';

/**
 * Cleanup, archiving and deletion of sessions. Management routes: Access
 * token required, refused to session processes like every route that is
 * not exempt.
 */
@Controller('sessions/:id')
export class SessionManagementController {
  constructor(private readonly management: SessionManagementService) {}

  /** What cleaning up the session's directories would do and lose. */
  @Get('cleanup')
  cleanupPreview(@Param('id') id: string): Promise<CleanupPreview> {
    return this.management.cleanupPreview(id);
  }

  /** Pushes, merges, discards or keeps the session's directories. */
  @Post('cleanup')
  @HttpCode(200)
  cleanup(
    @Param('id') id: string,
    @Body() body: CleanupRequest,
  ): Promise<CleanupResult> {
    return this.management.cleanup(id, body);
  }

  /** Ends the session, cleans up as chosen and hides it from the list. */
  @Post('archive')
  @HttpCode(200)
  archive(
    @Param('id') id: string,
    @Body() body: ArchiveRequest,
  ): Promise<CleanupResult> {
    return this.management.archive(id, body ?? {});
  }

  @Post('unarchive')
  @HttpCode(200)
  unarchive(@Param('id') id: string): SessionDto {
    return this.management.unarchive(id);
  }

  /** What deleting the session removes. */
  @Get('deletion')
  deletionPreview(@Param('id') id: string): Promise<DeletionPreview> {
    return this.management.deletionPreview(id);
  }

  /** Deletes the session for good (usage stays in the statistics). */
  @Post('delete')
  @HttpCode(204)
  delete(
    @Param('id') id: string,
    @Body() body: DeleteSessionRequest,
  ): Promise<void> {
    return this.management.delete(id, body);
  }
}
