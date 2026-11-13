import { Controller, Get, Query } from '@nestjs/common';
import type { UsageStatistics } from '@claude-remote-manager/shared-types';
import { UsageStatisticsService } from './usage-statistics.service';

/** Usage statistics (management route). */
@Controller('usage')
export class UsageController {
  constructor(private readonly statistics: UsageStatisticsService) {}

  /** `?granularity=day|week|month&groupBy=session|repository|model&tz=&from=&to=` */
  @Get()
  get(
    @Query('granularity') granularity?: string,
    @Query('groupBy') groupBy?: string,
    @Query('tz') tz?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): UsageStatistics {
    return this.statistics.statistics({ granularity, groupBy, tz, from, to });
  }
}
