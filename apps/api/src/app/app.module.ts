import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AccountsModule } from './accounts/accounts.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './db/database.module';
import { EnvironmentsModule } from './environments/environments.module';
import { GitHubModule } from './github/github.module';
import { HealthController } from './health/health.controller';
import { LimitsModule } from './limits/limits.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrAutomationModule } from './pr-automation/pr-automation.module';
import { ReviewsModule } from './reviews/reviews.module';
import { RepositoriesModule } from './repositories/repositories.module';
import {
  REQUEST_GUARD_EXEMPT_ROUTES,
  RequestGuardMiddleware,
} from './security/request-guard.middleware';
import { SearchModule } from './search/search.module';
import { UsageModule } from './usage/usage.module';
import { SecurityModule } from './security/security.module';
import { SessionsModule } from './sessions/sessions.module';
import { SettingsModule } from './settings/settings.module';

/**
 * Directory with the built web app. In the image it sits next to the API
 * bundle; during development the Angular dev server serves the app instead.
 */
const webRoot = resolve(process.env.WEB_ROOT || join(__dirname, 'public'));

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    SecurityModule,
    SettingsModule,
    EnvironmentsModule,
    GitHubModule,
    LimitsModule,
    AccountsModule,
    RepositoriesModule,
    SessionsModule,
    NotificationsModule,
    PrAutomationModule,
    ReviewsModule,
    SearchModule,
    UsageModule,
    ...(existsSync(webRoot)
      ? [
          ServeStaticModule.forRoot({
            rootPath: webRoot,
            exclude: ['/api/{*path}'],
          }),
        ]
      : []),
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestGuardMiddleware)
      .exclude(...REQUEST_GUARD_EXEMPT_ROUTES)
      .forRoutes('{*path}');
  }
}
