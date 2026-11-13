import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import type { GitHubRepositoryListResponse } from '@claude-remote-manager/shared-types';
import { RepositoriesService } from './repositories.service';

function positiveInteger(value: string | undefined, name: string) {
  if (value === undefined || value === '') {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new BadRequestException(`${name} must be a positive integer`);
  }
  return number;
}

/** Repositories the GitHub App's installations can access. */
@Controller('github/repositories')
export class GitHubRepositoriesController {
  constructor(private readonly repositories: RepositoriesService) {}

  /**
   * Searchable, paginated list over all installations (personal account
   * and organizations); GitHub is asked at most once a minute unless
   * `refresh=true`.
   */
  @Get()
  list(
    @Query('query') query?: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
    @Query('refresh') refresh?: string,
  ): Promise<GitHubRepositoryListResponse> {
    if (
      query !== undefined &&
      (typeof query !== 'string' || query.length > 200)
    ) {
      throw new BadRequestException(
        'query must be a string of at most 200 characters',
      );
    }
    return this.repositories.githubRepositories({
      query,
      page: positiveInteger(page, 'page'),
      perPage: positiveInteger(perPage, 'perPage'),
      refresh: refresh === 'true',
    });
  }
}
