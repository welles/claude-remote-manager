import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import type { PreviewDto } from '@claude-remote-manager/shared-types';
import { PreviewsService } from './previews.service';

/**
 * Previews of a session (the list comes with the session, `previews` of
 * `SessionDto`). Management routes: session processes are refused like
 * everywhere in the API, so a session cannot stop or expose anything
 * here; it exposes only through its own tool.
 */
@Controller('sessions/:id/previews')
export class PreviewsController {
  constructor(private readonly previews: PreviewsService) {}

  /** Ends the forwarding (the dev server keeps running). */
  @Post(':previewId/stop')
  @HttpCode(200)
  stop(
    @Param('id') sessionId: string,
    @Param('previewId') previewId: string,
  ): PreviewDto {
    return this.previews.stop(sessionId, previewId);
  }
}
