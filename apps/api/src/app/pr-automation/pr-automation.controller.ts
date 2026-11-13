import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import type {
  CloneLossReport,
  DiscardCloneRequest,
  SessionDto,
  UpdatePullRequestAutomationRequest,
} from '@claude-remote-manager/shared-types';
import { PrAutomationService } from './pr-automation.service';

/**
 * The PR automation of a session's pull requests, and the clones autoclose
 * kept. Management routes: Access token required, refused to session
 * processes like every route that is not exempt.
 */
@Controller('sessions/:id')
export class PrAutomationController {
  constructor(private readonly automation: PrAutomationService) {}

  /** Switches autofix or autoclose, sets the attempt limit or resets the count. */
  @Patch('pull-requests/:pullRequestId/automation')
  update(
    @Param('id') id: string,
    @Param('pullRequestId', ParseIntPipe) pullRequestId: number,
    @Body() body: UpdatePullRequestAutomationRequest,
  ): SessionDto {
    return this.automation.update(id, pullRequestId, body ?? {});
  }

  /** Stops the running autofix run and turns autofix off for its PR. */
  @Post('autofix/stop')
  @HttpCode(200)
  stop(@Param('id') id: string): Promise<SessionDto> {
    return this.automation.stop(id);
  }

  /** What deleting the clone of a repository would lose. */
  @Get('repositories/:repositoryId/clone-loss')
  cloneLoss(
    @Param('id') id: string,
    @Param('repositoryId') repositoryId: string,
  ): Promise<CloneLossReport> {
    return this.automation.cloneLoss(id, repositoryId);
  }

  /** Deletes a clone of an ended session (after the user confirmed). */
  @Post('repositories/:repositoryId/discard-clone')
  @HttpCode(200)
  discardClone(
    @Param('id') id: string,
    @Param('repositoryId') repositoryId: string,
    @Body() body: DiscardCloneRequest,
  ): Promise<SessionDto> {
    return this.automation.discardClone(id, repositoryId, body ?? {});
  }
}
