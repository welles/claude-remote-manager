import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import {
  SessionGitHubTokensService,
  type SessionGitHubToken,
} from './session-github-tokens.service';

/**
 * Endpoints of the GitHub token helper of session processes (container
 * only, see {@link SessionGitHubTokensService}). Exempt from the Access
 * token and open only to session processes (see `AUTH_EXEMPT_ROUTES`);
 * authenticated with the session's process token (Bearer).
 */
@Controller('session-tokens')
export class SessionGitHubTokensController {
  constructor(private readonly tokens: SessionGitHubTokensService) {}

  /** For git's credential helper: one repository, `contents: write`. */
  @Post('git')
  @HttpCode(200)
  git(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<SessionGitHubToken> {
    return this.tokens.forGit(authorization, body);
  }

  /** For `gh`: the session's repositories, read only. */
  @Post('gh')
  @HttpCode(200)
  gh(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<SessionGitHubToken> {
    return this.tokens.forGh(authorization, body);
  }
}
