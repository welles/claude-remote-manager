import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { UsageController } from './usage.controller';
import { UsageStatisticsService } from './usage-statistics.service';

/** Usage statistics over time. */
@Module({
  imports: [SessionsModule],
  controllers: [UsageController],
  providers: [UsageStatisticsService],
})
export class UsageModule {}
