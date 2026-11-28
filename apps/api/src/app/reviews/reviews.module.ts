import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { ReviewDefaultsStore } from './review-defaults';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

/**
 * Independent reviews: a separate, read-only process of the reviewer's
 * engine (Claude Code or Codex) reviews a session's changes and its
 * findings go to the session's agent.
 */
@Module({
  imports: [SessionsModule],
  controllers: [ReviewsController],
  providers: [ReviewDefaultsStore, ReviewsService],
})
export class ReviewsModule {}
