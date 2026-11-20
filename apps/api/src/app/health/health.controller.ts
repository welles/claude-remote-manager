import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@claude-remote-manager/shared-types';
import { serverTimeZone } from '../common/time-zone';

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      version: process.env.APP_VERSION || '0.0.0',
      commit: process.env.APP_COMMIT || null,
      commitTime: process.env.APP_COMMIT_TIME || null,
      timeZone: serverTimeZone(process.env.TZ),
    };
  }
}
