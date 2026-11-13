import { Global, Logger, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { GitHubAppCredentials } from './github-app-credentials';
import { GitHubController } from './github.controller';
import { GITHUB_FETCH, GitHubHttp, type FetchLike } from './github-http';
import { GitHubService } from './github.service';
import { InstallationTokens } from './installation-tokens';

/**
 * The GitHub App client. Global, because repositories, sessions and their
 * tools all talk to GitHub. Tests replace {@link GITHUB_FETCH} with a fake
 * GitHub and {@link GitHubAppCredentials} with a test key.
 */
@Global()
@Module({
  controllers: [GitHubController],
  providers: [
    {
      provide: GITHUB_FETCH,
      useValue: ((url, init) => fetch(url, init)) satisfies FetchLike,
    },
    {
      provide: GitHubAppCredentials,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const credentials = GitHubAppCredentials.load(config.github);
        const logger = new Logger('GitHub');
        if (credentials.configured) {
          logger.log(`Using GitHub App ${credentials.appId}`);
        } else {
          logger.warn(`GitHub is not configured: ${credentials.problem}`);
        }
        return credentials;
      },
    },
    {
      provide: GitHubHttp,
      inject: [GITHUB_FETCH],
      useFactory: (fetchImpl: FetchLike) => new GitHubHttp(fetchImpl),
    },
    {
      provide: InstallationTokens,
      inject: [GitHubAppCredentials, GitHubHttp],
      useFactory: (credentials: GitHubAppCredentials, http: GitHubHttp) =>
        new InstallationTokens(credentials, http),
    },
    {
      provide: GitHubService,
      inject: [GitHubAppCredentials, GitHubHttp, InstallationTokens],
      useFactory: (
        credentials: GitHubAppCredentials,
        http: GitHubHttp,
        tokens: InstallationTokens,
      ) => new GitHubService(credentials, http, tokens),
    },
  ],
  exports: [GitHubService, GitHubAppCredentials, InstallationTokens],
})
export class GitHubModule {}
