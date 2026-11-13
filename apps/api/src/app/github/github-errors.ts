import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Errors of the GitHub integration. They are HTTP exceptions, so a REST
 * handler that lets one through answers with a clear status and message;
 * outside requests (tools, background work) they are ordinary errors.
 */

/** The GitHub App is not configured (or its key could not be read). */
export class GitHubNotConfiguredError extends HttpException {
  constructor(detail?: string) {
    super(
      detail
        ? `The GitHub App is not configured: ${detail}`
        : 'The GitHub App is not configured (set GITHUB_APP_ID and the private key)',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    this.name = 'GitHubNotConfiguredError';
  }
}

/** GitHub answered a request with an error status. */
export class GitHubApiError extends HttpException {
  constructor(
    readonly githubStatus: number,
    message: string,
    /** Validation errors GitHub listed (422), as plain text. */
    readonly details: string[] = [],
  ) {
    super(
      `GitHub: ${message}${details.length ? ` (${details.join('; ')})` : ''}`,
      // 404 stays 404 (repository or installation gone), everything else
      // is a failed upstream request.
      githubStatus === 404 ? HttpStatus.NOT_FOUND : HttpStatus.BAD_GATEWAY,
    );
    this.name = 'GitHubApiError';
  }
}

/** A primary or secondary rate limit; retry after `resetAt`. */
export class GitHubRateLimitError extends HttpException {
  constructor(
    readonly resetAt: Date,
    readonly secondary: boolean,
  ) {
    super(
      `GitHub's ${secondary ? 'secondary ' : ''}rate limit was reached; try again after ${resetAt.toISOString()}`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
    this.name = 'GitHubRateLimitError';
  }
}

/** GitHub could not be reached (network error or timeout). */
export class GitHubUnavailableError extends HttpException {
  constructor(detail: string) {
    super(`GitHub is not reachable: ${detail}`, HttpStatus.BAD_GATEWAY);
    this.name = 'GitHubUnavailableError';
  }
}
