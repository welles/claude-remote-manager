import {
  Global,
  Inject,
  Logger,
  Module,
  type OnModuleInit,
} from '@nestjs/common';
import {
  APP_CONFIG,
  ENVIRONMENT_KEY_VARIABLE,
  type AppConfig,
} from '../config/app-config';
import {
  PROCESS_LAUNCHER,
  type ProcessLauncher,
} from '../common/process-isolation';
import { EnvironmentFiles } from './environment-files';
import { EnvironmentsController } from './environments.controller';
import { EnvironmentsService, SECRET_CIPHER } from './environments.service';
import { SecretCipher } from './secret-cipher';

@Global()
@Module({
  controllers: [EnvironmentsController],
  providers: [
    {
      provide: SECRET_CIPHER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new SecretCipher(
          config.environmentKeyFile,
          process.env[ENVIRONMENT_KEY_VARIABLE],
        ),
    },
    {
      provide: EnvironmentFiles,
      inject: [APP_CONFIG, PROCESS_LAUNCHER],
      useFactory: (config: AppConfig, launcher: ProcessLauncher) =>
        new EnvironmentFiles(config.environmentFilesDir, launcher),
    },
    EnvironmentsService,
  ],
  exports: [EnvironmentsService, EnvironmentFiles],
})
export class EnvironmentsModule implements OnModuleInit {
  private readonly logger = new Logger(EnvironmentsModule.name);

  constructor(
    @Inject(EnvironmentFiles) private readonly files: EnvironmentFiles,
  ) {}

  /** Files of processes from before a restart are no longer needed. */
  async onModuleInit(): Promise<void> {
    try {
      await this.files.clear();
    } catch (error) {
      this.logger.warn(
        `Could not remove old environment files: ${String(error)}`,
      );
    }
  }
}
