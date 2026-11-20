import { Controller, Get } from '@nestjs/common';
import type { AppSettingsDto } from '@claude-remote-manager/shared-types';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get(): AppSettingsDto {
    return this.settings.get();
  }
}
