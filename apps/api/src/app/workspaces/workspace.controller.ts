import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import type {
  ForgetMissingRequest,
  RemoveOrphanRequest,
  SessionDto,
  WorkspaceOrphansResponse,
} from '@claude-remote-manager/shared-types';
import { WorkspaceOrphansService } from './workspace-orphans.service';

/** Leftovers in the workspace (management routes). */
@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly orphans: WorkspaceOrphansService) {}

  @Get('orphans')
  list(): Promise<WorkspaceOrphansResponse> {
    return this.orphans.list();
  }

  @Post('orphans/remove')
  @HttpCode(200)
  remove(@Body() body: RemoveOrphanRequest): Promise<WorkspaceOrphansResponse> {
    return this.orphans.remove(body);
  }

  @Post('missing/forget')
  @HttpCode(200)
  forget(@Body() body: ForgetMissingRequest): Promise<SessionDto> {
    return this.orphans.forgetMissing(body);
  }
}
