import { Global, Module } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Authenticator } from '../auth/authenticator';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { RequestGuardMiddleware } from './request-guard.middleware';
import { RequestPolicy } from './request-policy';

@Global()
@Module({
  providers: [
    {
      provide: RequestPolicy,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new RequestPolicy({
          allowedOrigins: config.allowedOrigins,
          allowedHosts: config.allowedHosts,
        }),
    },
    {
      provide: Authenticator,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const logger = new Logger('Auth');
        if (config.auth.mode === 'none') {
          logger.warn(
            'AUTH_MODE=none: the API is not authenticated. Use this only for local development, never behind a tunnel or on a shared network.',
          );
        } else {
          logger.log(
            `Verifying Cloudflare Access tokens of ${config.auth.access.teamDomain}`,
          );
        }
        return new Authenticator(config.auth, config.isolation);
      },
    },
    RequestGuardMiddleware,
  ],
  exports: [RequestPolicy, RequestGuardMiddleware, Authenticator],
})
export class SecurityModule {}
