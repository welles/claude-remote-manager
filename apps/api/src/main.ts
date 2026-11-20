import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app/app.module';
import { checkSeparateUsers } from './app/common/process-isolation';
import {
  APP_CONFIG,
  loadAppConfig,
  type AppConfig,
} from './app/config/app-config';
import { migrateLegacyTranscripts } from './app/sessions/legacy-transcripts';
import { claudeConfigDir } from './app/sessions/session-management.service';
import { configureApp } from './app/configure-app';

/**
 * Copies transcripts from the configuration directory of an earlier
 * version before anything resumes a session (see
 * `migrateLegacyTranscripts`). A failure is logged; the API starts anyway.
 */
async function migrateLegacyClaudeData(config: AppConfig): Promise<void> {
  if (!config.legacyClaudeConfigDir) {
    return;
  }
  try {
    const result = await migrateLegacyTranscripts(
      config.legacyClaudeConfigDir,
      claudeConfigDir(),
      config.memoryDir,
    );
    if (result) {
      Logger.log(
        `Copied ${result.copied} transcript entries from ${config.legacyClaudeConfigDir} to ${claudeConfigDir()} (${result.skipped} existed already)${result.memoryMoved ? `; repository memory moved to ${config.memoryDir}` : ''}`,
      );
    }
  } catch (error) {
    Logger.error(
      `Could not copy the transcripts of ${config.legacyClaudeConfigDir}: ${error instanceof Error ? error.message : String(error)}; sessions created before cannot be resumed until this succeeds`,
    );
  }
}

async function bootstrap() {
  await migrateLegacyClaudeData(loadAppConfig());
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  const globalPrefix = 'api';
  const config = app.get<AppConfig>(APP_CONFIG);
  // Refuses to start when the separation of users cannot work.
  checkSeparateUsers(config.isolation);
  Logger.log(
    config.isolation.mode === 'separate-users'
      ? `Session processes run as ${config.isolation.sessionUser.name}`
      : 'PROCESS_ISOLATION=single-user: session processes run as the API user, with its rights',
  );
  if (!config.gitIdentity) {
    Logger.warn(
      'CRM_GIT_AUTHOR_NAME and CRM_GIT_AUTHOR_EMAIL are not set: sessions with repositories cannot start, existing clones cannot commit',
    );
  }
  configureApp(app);
  // Run onModuleDestroy/onApplicationShutdown hooks on SIGTERM/SIGINT, e.g.
  // to stop sessions and dev servers when the container stops.
  app.enableShutdownHooks();
  const port = process.env.PORT || 3000;
  // All interfaces unless LISTEN_ADDRESS names one (the NixOS module sets it).
  const address = process.env.LISTEN_ADDRESS?.trim();
  await (address ? app.listen(port, address) : app.listen(port));
  // Set when Nx waits for this server to be ready
  if (process.env.NX_READY_SIGNAL_SOCKET) {
    try {
      // Function keeps TypeScript and bundlers from rewriting or bundling the import
      const load = new Function('s', 'return import(s)') as (
        s: string,
      ) => Promise<{ emitReadySignal(server: unknown): boolean }>;
      (await load('@nx/js/ready-signal')).emitReadySignal(app.getHttpServer());
    } catch {
      // @nx/js isn't installed
    }
  }
  Logger.log(
    `Application is running on: http://localhost:${port}/${globalPrefix}`,
  );
}

bootstrap();
