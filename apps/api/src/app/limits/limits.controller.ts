import { Controller, Get } from '@nestjs/common';
import type { AccountLimits } from '@claude-remote-manager/shared-types';
import { LimitsService } from './limits.service';

@Controller('limits')
export class LimitsController {
  constructor(private readonly limits: LimitsService) {}

  /** Latest known subscription rate limits of the Claude account. */
  @Get()
  get(): AccountLimits {
    return this.limits.get();
  }
}
