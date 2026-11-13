import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/** Full-text search over sessions and their conversations. */
@Module({
  imports: [SessionsModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
