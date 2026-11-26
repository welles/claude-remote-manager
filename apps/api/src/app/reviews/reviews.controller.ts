import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import type {
  ReviewDefaults,
  SessionDto,
  StartReviewResponse,
  UpdateReviewDefaultsRequest,
  UpdateSessionReviewRequest,
} from '@claude-remote-manager/shared-types';
import { ReviewsService } from './reviews.service';

/**
 * Independent reviews of sessions' changes and their settings. Management
 * routes: Access token required, refused to session processes like every
 * route that is not exempt.
 */
@Controller()
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** The app's review settings (model, effort). */
  @Get('settings/review')
  defaults(): ReviewDefaults {
    return this.reviews.getDefaults();
  }

  @Put('settings/review')
  updateDefaults(@Body() body: UpdateReviewDefaultsRequest): ReviewDefaults {
    return this.reviews.updateDefaults(body);
  }

  /** Starts a review of the session's changes now. */
  @Post('sessions/:id/review')
  async start(@Param('id') id: string): Promise<StartReviewResponse> {
    return { review: await this.reviews.start(id) };
  }

  /** Stops the session's running review. */
  @Delete('sessions/:id/review')
  @HttpCode(204)
  cancel(@Param('id') id: string): void {
    this.reviews.cancel(id);
  }

  /** Auto-review, model and effort of the session's reviews. */
  @Put('sessions/:id/review-settings')
  updateSession(
    @Param('id') id: string,
    @Body() body: UpdateSessionReviewRequest,
  ): SessionDto {
    return this.reviews.updateSession(id, body);
  }
}
