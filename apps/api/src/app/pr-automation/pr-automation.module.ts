import { Logger, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { GitHubHttp } from '../github/github-http';
import { GitHubService } from '../github/github.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { PreviewsModule } from '../previews/previews.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { SessionsModule } from '../sessions/sessions.module';
import { PrAutomationController } from './pr-automation.controller';
import {
  automationTiming,
  PR_AUTOMATION_TIMING,
  PrAutomationService,
} from './pr-automation.service';
import { PullRequestChecksService } from './pull-request-checks.service';
import { PullRequestFeedback } from './pull-request-feedback';
import { WebhookDeliveryRepository } from './webhook-deliveries.repository';
import { WebhookController, WebhookHandler } from './webhook.controller';
import { WebhookSecret } from './webhook-signature';

/**
 * PR automation: autofix and autoclose of session pull requests, fed by
 * the GitHub App's webhook (`POST /api/github/webhook`) and by polling.
 */
@Module({
  imports: [
    SessionsModule,
    NotificationsModule,
    RepositoriesModule,
    PreviewsModule,
  ],
  controllers: [PrAutomationController, WebhookController],
  providers: [
    {
      provide: WebhookSecret,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const secret = WebhookSecret.load(
          config.prAutomation.webhookSecretFile,
        );
        const logger = new Logger('GitHubWebhook');
        if (secret.configured) {
          logger.log('GitHub webhook deliveries are accepted (signed)');
        } else {
          logger.log(
            'No GitHub webhook secret: the webhook refuses every delivery; pull requests are polled',
          );
        }
        return secret;
      },
    },
    {
      provide: PR_AUTOMATION_TIMING,
      inject: [APP_CONFIG, WebhookSecret],
      useFactory: (config: AppConfig, secret: WebhookSecret) =>
        automationTiming(config, secret.configured),
    },
    {
      provide: PullRequestFeedback,
      inject: [GitHubService, GitHubHttp],
      useFactory: (github: GitHubService, http: GitHubHttp) =>
        new PullRequestFeedback(github, http),
    },
    WebhookDeliveryRepository,
    PullRequestChecksService,
    PrAutomationService,
    { provide: WebhookHandler, useExisting: PrAutomationService },
  ],
})
export class PrAutomationModule {}
