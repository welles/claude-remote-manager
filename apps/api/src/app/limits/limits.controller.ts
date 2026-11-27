import { Controller, Get } from '@nestjs/common';
import type { AccountLimitsListResponse } from '@claude-remote-manager/shared-types';
import { LimitsService } from './limits.service';

@Controller('limits')
export class LimitsController {
  constructor(private readonly limits: LimitsService) {}

  /**
   * Latest known subscription rate limits of every Claude account. Stale or
   * unknown values are read again in the background; the new values
   * arrive as `account.limits` frames.
   */
  @Get()
  get(): AccountLimitsListResponse {
    this.limits.refreshIfStale();
    return { accounts: this.limits.list() };
  }
}
