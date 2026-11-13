import { Controller, Get } from '@nestjs/common';
import type { ModelListResponse } from '@claude-remote-manager/shared-types';
import { ModelsService } from './models.service';

@Controller('models')
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  /** Models a session can use (for the model choice). */
  @Get()
  list(): Promise<ModelListResponse> {
    return this.models.list();
  }
}
