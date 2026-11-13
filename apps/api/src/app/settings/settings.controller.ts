import { Body, Controller, Get, Put } from '@nestjs/common';
import type {
  AppSettingsDto,
  UpdateSettingsRequest,
} from '@claude-remote-manager/shared-types';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get(): AppSettingsDto {
    return this.settings.get();
  }

  /** Changes the given settings; the others stay. */
  @Put()
  update(@Body() request: UpdateSettingsRequest): AppSettingsDto {
    return this.settings.update(request);
  }
}
