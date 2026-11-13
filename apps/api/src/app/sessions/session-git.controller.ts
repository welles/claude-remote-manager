import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import type {
  CreatePullRequestRequest,
  PullRequestDto,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { SessionGitService } from './session-git.service';
import { SessionsService } from './sessions.service';

/**
 * Push and pull requests per repository of a session, by button. The
 * user's click is the approval; Claude's own pushes and pull requests go
 * through the approval of the tool call instead.
 */
@Controller('sessions/:id')
export class SessionGitController {
  constructor(
    private readonly git: SessionGitService,
    private readonly sessions: SessionsService,
  ) {}

  /** Pushes the session branch of the repository's clone. */
  @Post('repositories/:repositoryId/push')
  @HttpCode(200)
  async push(
    @Param('id') id: string,
    @Param('repositoryId') repositoryId: string,
  ): Promise<SessionDto> {
    await this.git.push(id, repositoryId);
    return this.sessions.get(id);
  }

  /** Creates a pull request (pushing the branch first if needed). */
  @Post('repositories/:repositoryId/pull-requests')
  createPullRequest(
    @Param('id') id: string,
    @Param('repositoryId') repositoryId: string,
    @Body() request: CreatePullRequestRequest,
  ): Promise<PullRequestDto> {
    return this.git.createPullRequest(id, repositoryId, request ?? {}, 'user');
  }

  /** Reads the state of the session's open pull requests from GitHub. */
  @Post('pull-requests/refresh')
  @HttpCode(200)
  async refreshPullRequests(@Param('id') id: string): Promise<SessionDto> {
    await this.git.refreshPullRequests(id, true);
    return this.sessions.get(id);
  }
}
