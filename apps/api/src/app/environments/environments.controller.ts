import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import type {
  EnvironmentDto,
  EnvironmentListResponse,
  SaveEnvironmentRequest,
} from '@claude-remote-manager/shared-types';
import { EnvironmentsService } from './environments.service';

/** Environments; secret values are write-only (see the service). */
@Controller('environments')
export class EnvironmentsController {
  constructor(private readonly environments: EnvironmentsService) {}

  @Get()
  list(): EnvironmentListResponse {
    return { environments: this.environments.list() };
  }

  @Get(':id')
  get(@Param('id') id: string): EnvironmentDto {
    return this.environments.get(id);
  }

  @Post()
  create(@Body() request: SaveEnvironmentRequest): EnvironmentDto {
    return this.environments.create(request);
  }

  /** Replaces the whole environment; entries left out are deleted. */
  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() request: SaveEnvironmentRequest,
  ): EnvironmentDto {
    return this.environments.update(id, request);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): void {
    this.environments.remove(id);
  }
}
