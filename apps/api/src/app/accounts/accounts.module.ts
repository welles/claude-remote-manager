import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import {
  PROCESS_LAUNCHER,
  type ProcessLauncher,
} from '../common/process-isolation';
import { LimitsModule } from '../limits/limits.module';
import { AccountsController } from './accounts.controller';
import {
  AccountsService,
  CLAUDE_ACCOUNT_DIRECTORIES,
  CLAUDE_CLI,
} from './accounts.service';
import { ClaudeAccountDirectories } from './claude-account-directories';
import { ClaudeCli, resolveClaudeExecutable } from './claude-cli';

@Global()
@Module({
  imports: [LimitsModule],
  controllers: [AccountsController],
  providers: [
    {
      provide: CLAUDE_CLI,
      inject: [APP_CONFIG, PROCESS_LAUNCHER],
      useFactory: (config: AppConfig, launcher: ProcessLauncher) =>
        new ClaudeCli(
          resolveClaudeExecutable(config.claudeExecutable),
          launcher,
        ),
    },
    {
      provide: CLAUDE_ACCOUNT_DIRECTORIES,
      inject: [PROCESS_LAUNCHER],
      useFactory: (launcher: ProcessLauncher) =>
        ClaudeAccountDirectories.forEnvironment(launcher),
    },
    AccountsService,
  ],
  exports: [AccountsService],
})
export class AccountsModule {}
