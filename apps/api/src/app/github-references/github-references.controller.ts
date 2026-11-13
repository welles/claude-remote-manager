import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import type {
  GitHubReferenceDetail,
  GitHubReferenceSearchResponse,
} from '@claude-remote-manager/shared-types';
import { GitHubReferencesService } from './github-references.service';

/**
 * Issues and pull requests for `#` references in the input: suggestions
 * and the preview of a chip. Only repositories the GitHub App's
 * installations can access are asked.
 */
@Controller('github/references')
export class GitHubReferencesController {
  constructor(private readonly references: GitHubReferencesService) {}

  /**
   * `query`: what was typed after `#` (number, title words, or nothing);
   * `repositories`: comma-separated `owner/name` to search.
   */
  @Get()
  search(
    @Query('query') query: unknown,
    @Query('repositories') repositories: unknown,
  ): Promise<GitHubReferenceSearchResponse> {
    if (query !== undefined && typeof query !== 'string') {
      throw new BadRequestException('query must be a string');
    }
    if (repositories !== undefined && typeof repositories !== 'string') {
      throw new BadRequestException(
        'repositories must be a comma-separated list',
      );
    }
    const names = (repositories ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    return this.references.search(query ?? '', names);
  }

  @Get(':owner/:name/:number')
  detail(
    @Param('owner') owner: string,
    @Param('name') name: string,
    @Param('number') number: string,
  ): Promise<GitHubReferenceDetail> {
    if (!/^[1-9]\d{0,8}$/.test(number)) {
      throw new BadRequestException('number must be an issue number');
    }
    return this.references.detail(`${owner}/${name}`, Number(number));
  }
}
