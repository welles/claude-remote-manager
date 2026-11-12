import { Global, Module } from '@nestjs/common';
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
    RequestGuardMiddleware,
  ],
  exports: [RequestPolicy, RequestGuardMiddleware],
})
export class SecurityModule {}
