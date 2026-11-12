import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './db/database.module';
import { HealthController } from './health/health.controller';
import { LimitsModule } from './limits/limits.module';
import {
  REQUEST_GUARD_EXEMPT_ROUTES,
  RequestGuardMiddleware,
} from './security/request-guard.middleware';
import { SecurityModule } from './security/security.module';
import { SessionsModule } from './sessions/sessions.module';

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
    LimitsModule,
    SessionsModule,
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
