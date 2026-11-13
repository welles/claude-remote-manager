import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import {
  GitCredentialsService,
  type GitCredentialResponse,
} from './git-credentials.service';

/**
 * Endpoint of the git credential helper in session clones. Authenticated
 * with the session's process token (Bearer), not by the request guard
 * alone: the guard lets non-browser clients through.
 */
@Controller('git')
export class GitCredentialsController {
  constructor(private readonly credentials: GitCredentialsService) {}

  @Post('credentials')
  @HttpCode(200)
  get(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<GitCredentialResponse> {
    return this.credentials.credentials(authorization, body);
  }
}
