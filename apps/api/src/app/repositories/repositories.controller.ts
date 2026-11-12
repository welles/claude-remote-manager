import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type {
  CreateRepositoryRequest,
  RepositoryBranchesResponse,
  RepositoryDto,
  RepositoryListResponse,
  UpdateRepositoryRequest,
} from '@claude-remote-manager/shared-types';
import { RepositoriesService } from './repositories.service';

/**
 * Registered repositories. Cloning and fetching run in the background;
 * `activity` in the response shows them, clients poll while it is set.
 */
@Controller('repositories')
export class RepositoriesController {
  constructor(private readonly repositories: RepositoriesService) {}

  @Get()
  list(): Promise<RepositoryListResponse> {
    return this.repositories.list();
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<RepositoryDto> {
    return this.repositories.get(id);
  }

  /** Registers a repository by clone URL and starts cloning it. */
  @Post()
  create(@Body() request: CreateRepositoryRequest): Promise<RepositoryDto> {
    return this.repositories.register(request);
  }

  /** Changes the setup script. */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() request: UpdateRepositoryRequest,
  ): Promise<RepositoryDto> {
    return this.repositories.updateSettings(id, request);
  }

  /** Fetches the repository (clones it if missing) in the background. */
  @Post(':id/fetch')
  @HttpCode(202)
  fetch(@Param('id') id: string): Promise<RepositoryDto> {
    return this.repositories.refresh(id);
  }

  @Get(':id/branches')
  branches(@Param('id') id: string): Promise<RepositoryBranchesResponse> {
    return this.repositories.branches(id);
  }
}
