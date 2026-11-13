import { Controller, Get } from '@nestjs/common';
import type { GitHubStatusDto } from '@claude-remote-manager/shared-types';
import { GitHubService } from './github.service';

/** State of the GitHub App for the UI. */
@Controller('github')
export class GitHubController {
  constructor(private readonly github: GitHubService) {}

  /**
   * Whether the app is configured, its name, and its installations with
   * their repository counts. Never fails: problems are part of the answer.
   */
  @Get('status')
  status(): Promise<GitHubStatusDto> {
    return this.github.status();
  }
}
