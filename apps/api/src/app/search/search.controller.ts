import { Controller, Get, Query } from '@nestjs/common';
import type { SearchResponse } from '@claude-remote-manager/shared-types';
import { SearchService } from './search.service';

/** Full-text search over sessions (management route). */
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  find(@Query('q') query: unknown): SearchResponse {
    return this.search.search(query);
  }
}
