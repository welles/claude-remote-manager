import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import {
  AGENT_ENGINES,
  DEFAULT_ENGINE,
  type AgentEngineId,
  type ModelListResponse,
} from '@claude-remote-manager/shared-types';
import { ModelsService } from './models.service';

@Controller('models')
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  /** Models a session of an engine can use (for the model choice). */
  @Get()
  list(@Query('engine') engine?: string): Promise<ModelListResponse> {
    if (
      engine !== undefined &&
      !AGENT_ENGINES.includes(engine as AgentEngineId)
    ) {
      throw new BadRequestException('engine is not a known engine');
    }
    return this.models.list(
      (engine as AgentEngineId | undefined) ?? DEFAULT_ENGINE,
    );
  }
}
