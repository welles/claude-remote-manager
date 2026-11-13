import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app/app.module';
import { checkSeparateUsers } from './app/common/process-isolation';
import { APP_CONFIG, type AppConfig } from './app/config/app-config';
import { configureApp } from './app/configure-app';

async function bootstrap() {
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
      : 'PROCESS_ISOLATION=single-user: session processes run as the API user (local development only)',
  );
  configureApp(app);
  // Run onModuleDestroy/onApplicationShutdown hooks on SIGTERM/SIGINT, e.g.
  // to stop sessions and dev servers when the container stops.
  app.enableShutdownHooks();
  const port = process.env.PORT || 3000;
  await app.listen(port);
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
