import { Global, Module } from '@nestjs/common';
import { PROCESS_LAUNCHER, ProcessLauncher } from '../common/process-isolation';
import { APP_CONFIG, loadAppConfig, type AppConfig } from './app-config';

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadAppConfig() },
    {
      provide: PROCESS_LAUNCHER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new ProcessLauncher(config.isolation),
    },
  ],
  exports: [APP_CONFIG, PROCESS_LAUNCHER],
})
export class ConfigModule {}
